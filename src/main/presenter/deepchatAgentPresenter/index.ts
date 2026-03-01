import type {
  IAgentImplementation,
  DeepChatSessionState,
  ChatMessageRecord,
  UserMessageContent
} from '@shared/types/agent-interface'
import type { IConfigPresenter, ILlmProviderPresenter, ModelConfig } from '@shared/presenter'
import type { IToolPresenter } from '@shared/types/presenters/tool.presenter'
import type { SQLitePresenter } from '../sqlitePresenter'
import type { ChatMessage } from '@shared/types/core/chat-message'
import { DeepChatSessionStore } from './sessionStore'
import { DeepChatMessageStore } from './messageStore'
import { processStream } from './process'
import { buildContext } from './contextBuilder'
import { eventBus, SendTarget } from '@/eventbus'
import { SESSION_EVENTS } from '@/events'
import { PermissionChecker } from './permissionChecker'

export class DeepChatAgentPresenter implements IAgentImplementation {
  private llmProviderPresenter: ILlmProviderPresenter
  private configPresenter: IConfigPresenter
  private toolPresenter: IToolPresenter | null
  private sessionStore: DeepChatSessionStore
  private messageStore: DeepChatMessageStore
  private sqlitePresenter: SQLitePresenter
  private runtimeState: Map<string, DeepChatSessionState> = new Map()
  private abortControllers: Map<string, AbortController> = new Map()
  private permissionCheckers: Map<string, PermissionChecker> = new Map()

  constructor(
    llmProviderPresenter: ILlmProviderPresenter,
    configPresenter: IConfigPresenter,
    sqlitePresenter: SQLitePresenter,
    toolPresenter?: IToolPresenter
  ) {
    this.llmProviderPresenter = llmProviderPresenter
    this.configPresenter = configPresenter
    this.toolPresenter = toolPresenter ?? null
    this.sqlitePresenter = sqlitePresenter
    this.sessionStore = new DeepChatSessionStore(sqlitePresenter)
    this.messageStore = new DeepChatMessageStore(sqlitePresenter)

    // Crash recovery: mark any pending messages as error
    const recovered = this.messageStore.recoverPendingMessages()
    if (recovered > 0) {
      console.log(`DeepChatAgent: recovered ${recovered} pending messages to error status`)
    }
  }

  async initSession(
    sessionId: string,
    config: { providerId: string; modelId: string }
  ): Promise<void> {
    console.log(
      `[DeepChatAgent] initSession id=${sessionId} provider=${config.providerId} model=${config.modelId}`
    )
    this.sessionStore.create(sessionId, config.providerId, config.modelId)
    this.runtimeState.set(sessionId, {
      status: 'idle',
      providerId: config.providerId,
      modelId: config.modelId
    })

    // Create permission checker for this session
    this.createPermissionChecker(sessionId)
  }

  async destroySession(sessionId: string): Promise<void> {
    // Cancel any in-progress generation
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(sessionId)
    }

    // Clean up permission checker
    this.permissionCheckers.delete(sessionId)

    this.messageStore.deleteBySession(sessionId)
    this.sessionStore.delete(sessionId)
    this.runtimeState.delete(sessionId)
  }

  async getSessionState(sessionId: string): Promise<DeepChatSessionState | null> {
    const state = this.runtimeState.get(sessionId)
    if (state) return state

    // Fallback: rebuild from DB
    const dbSession = this.sessionStore.get(sessionId)
    if (!dbSession) return null

    const rebuilt: DeepChatSessionState = {
      status: 'idle',
      providerId: dbSession.provider_id,
      modelId: dbSession.model_id
    }
    this.runtimeState.set(sessionId, rebuilt)
    return rebuilt
  }

  async processMessage(sessionId: string, content: string): Promise<void> {
    const state = this.runtimeState.get(sessionId)
    if (!state) throw new Error(`Session ${sessionId} not found`)

    console.log(
      `[DeepChatAgent] processMessage session=${sessionId} content="${content.slice(0, 60)}"`
    )

    // Update status to generating
    state.status = 'generating'
    eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
      sessionId,
      status: 'generating'
    })

    try {
      // 1. Get provider and model config
      console.log(`[DeepChatAgent] getting provider instance for "${state.providerId}"`)
      const provider = (
        this.llmProviderPresenter as unknown as {
          getProviderInstance: (id: string) => {
            coreStream: (
              messages: ChatMessage[],
              modelId: string,
              modelConfig: ModelConfig,
              temperature: number,
              maxTokens: number,
              tools: import('@shared/presenter').MCPToolDefinition[]
            ) => AsyncGenerator<import('@shared/types/core/llm-events').LLMCoreStreamEvent>
          }
        }
      ).getProviderInstance(state.providerId)

      const modelConfig = this.configPresenter.getModelConfig(state.modelId, state.providerId)
      const temperature = modelConfig.temperature ?? 0.7
      const maxTokens = modelConfig.maxTokens ?? 4096

      // 2. Build messages for LLM BEFORE persisting (avoids duplicate user message)
      const systemPrompt = await this.configPresenter.getDefaultSystemPrompt()
      const messages = buildContext(
        sessionId,
        content,
        systemPrompt,
        modelConfig.contextLength,
        maxTokens,
        this.messageStore
      )
      console.log(
        `[DeepChatAgent] calling coreStream model=${state.modelId} temp=${temperature} maxTokens=${maxTokens} messages=${messages.length}`
      )

      // 3. Persist user message
      const userOrderSeq = this.messageStore.getNextOrderSeq(sessionId)
      const userContent: UserMessageContent = {
        text: content,
        files: [],
        links: [],
        search: false,
        think: false
      }
      const userMsgId = this.messageStore.createUserMessage(sessionId, userOrderSeq, userContent)
      console.log(`[DeepChatAgent] user message created id=${userMsgId} seq=${userOrderSeq}`)

      // 4. Create pending assistant message
      const assistantOrderSeq = this.messageStore.getNextOrderSeq(sessionId)
      const assistantMessageId = this.messageStore.createAssistantMessage(
        sessionId,
        assistantOrderSeq
      )
      console.log(
        `[DeepChatAgent] assistant message created id=${assistantMessageId} seq=${assistantOrderSeq}`
      )

      // 5. Fetch tool definitions if toolPresenter is available
      const abortController = new AbortController()
      this.abortControllers.set(sessionId, abortController)

      let tools: import('@shared/presenter').MCPToolDefinition[] = []
      if (this.toolPresenter) {
        try {
          tools = await this.toolPresenter.getAllToolDefinitions({
            chatMode: 'agent'
          })
          console.log(`[DeepChatAgent] fetched ${tools.length} tool definitions`)
        } catch (err) {
          console.error('[DeepChatAgent] failed to fetch tool definitions:', err)
        }
      }

      // 6. Get or create permission checker for this session
      let permissionChecker = this.permissionCheckers.get(sessionId)
      if (!permissionChecker) {
        permissionChecker = this.createPermissionChecker(sessionId)
      }

      // 7. Run unified stream processor (handles both simple and tool-calling flows)
      console.log(`[DeepChatAgent] starting processStream with ${tools.length} tools`)
      await processStream({
        messages,
        tools,
        toolPresenter: this.toolPresenter,
        permissionChecker,
        coreStream: provider.coreStream.bind(provider),
        modelId: state.modelId,
        modelConfig,
        temperature,
        maxTokens,
        io: {
          sessionId,
          messageId: assistantMessageId,
          messageStore: this.messageStore,
          abortSignal: abortController.signal
        }
      })

      // 8. Update status to idle
      console.log(`[DeepChatAgent] stream completed, status → idle`)
      state.status = 'idle'
      this.abortControllers.delete(sessionId)
      eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
        sessionId,
        status: 'idle'
      })
    } catch (err) {
      console.error('[DeepChatAgent] processMessage error:', err)
      state.status = 'error'
      this.abortControllers.delete(sessionId)
      eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
        sessionId,
        status: 'error'
      })
    }
  }

  async cancelGeneration(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(sessionId)
    }

    const state = this.runtimeState.get(sessionId)
    if (state) {
      state.status = 'idle'
      eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
        sessionId,
        status: 'idle'
      })
    }
  }

  async getMessages(sessionId: string): Promise<ChatMessageRecord[]> {
    return this.messageStore.getMessages(sessionId)
  }

  async getMessageIds(sessionId: string): Promise<string[]> {
    return this.messageStore.getMessageIds(sessionId)
  }

  async getMessage(messageId: string): Promise<ChatMessageRecord | null> {
    return this.messageStore.getMessage(messageId)
  }

  /**
   * Handle permission response from user
   * This is called by NewAgentPresenter when user approves/denies a permission request
   */
  handlePermissionResponse(
    sessionId: string,
    requestId: string,
    approved: boolean,
    remember: boolean
  ): void {
    const permissionChecker = this.permissionCheckers.get(sessionId)
    if (!permissionChecker) {
      console.warn(`[DeepChatAgent] No permission checker for session ${sessionId}`)
      return
    }

    permissionChecker.handlePermissionResponse(requestId, approved, remember)

    // Update session status based on whether there are still pending permissions
    const state = this.runtimeState.get(sessionId)
    if (state) {
      // Status will be updated by the permission flow in processStream
      // This is just for immediate UI feedback
      eventBus.sendToRenderer(SESSION_EVENTS.STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
        sessionId,
        status: state.status
      })
    }
  }

  /**
   * Create or update permission checker for a session
   */
  private createPermissionChecker(sessionId: string): PermissionChecker {
    // Get session info from DB
    const sessionRow = this.sqlitePresenter.newSessionsTable.get(sessionId)

    const sessionRecord = {
      id: sessionId,
      agentId: sessionRow?.agent_id ?? 'deepchat',
      title: sessionRow?.title ?? 'New Chat',
      projectDir: sessionRow?.project_dir ?? null,
      isPinned: sessionRow?.is_pinned === 1,
      permissionMode: (sessionRow?.permission_mode as 'default' | 'full') ?? 'default',
      createdAt: sessionRow?.created_at ?? Date.now(),
      updatedAt: sessionRow?.updated_at ?? Date.now()
    }

    const permissionChecker = new PermissionChecker(sessionRecord)
    this.permissionCheckers.set(sessionId, permissionChecker)
    return permissionChecker
  }
}
