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
import { nanoid } from 'nanoid'
import { DeepChatSessionStore } from './sessionStore'
import { DeepChatMessageStore } from './messageStore'
import { processStream } from './process'
import { buildContext } from './contextBuilder'
import { eventBus, SendTarget } from '@/eventbus'
import { SESSION_EVENTS } from '@/events'

export class DeepChatAgentPresenter implements IAgentImplementation {
  private llmProviderPresenter: ILlmProviderPresenter
  private configPresenter: IConfigPresenter
  private toolPresenter: IToolPresenter | null
  private sessionStore: DeepChatSessionStore
  private messageStore: DeepChatMessageStore
  private sqlitePresenter: SQLitePresenter
  private runtimeState: Map<string, DeepChatSessionState> = new Map()
  private abortControllers: Map<string, AbortController> = new Map()

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
  }

  async destroySession(sessionId: string): Promise<void> {
    // Cancel any in-progress generation
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(sessionId)
    }

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

      // 6. Run unified stream processor (handles both simple and tool-calling flows)
      console.log(`[DeepChatAgent] starting processStream with ${tools.length} tools`)
      await processStream({
        messages,
        tools,
        toolPresenter: this.toolPresenter,
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

      // 7. Update status to idle
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

  async editUserMessage(sessionId: string, messageId: string, newContent: string): Promise<void> {
    console.log(
      `[DeepChatAgent] editUserMessage session=${sessionId} message=${messageId} content="${newContent.slice(0, 60)}"`
    )

    const result = this.messageStore.editUserMessage(messageId, newContent)
    if (!result) {
      throw new Error(`Message not found or not a user message: ${messageId}`)
    }

    console.log(
      `[DeepChatAgent] editUserMessage deleted ${result.deletedCount} subsequent messages`
    )

    // Trigger regenerate by processing the edited message
    // This will create a new assistant response
    await this.processMessage(sessionId, newContent)
  }

  async forkSessionFromMessage(sessionId: string, messageId: string): Promise<string> {
    console.log(`[DeepChatAgent] forkSessionFromMessage session=${sessionId} message=${messageId}`)

    // Get the source session
    const sourceSession = this.sessionStore.get(sessionId)
    if (!sourceSession) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Get the message to fork from
    const message = this.messageStore.getMessage(messageId)
    if (!message) {
      throw new Error(`Message not found: ${messageId}`)
    }

    // Create new session with same configuration
    const newSessionId = nanoid()
    this.sessionStore.create(newSessionId, sourceSession.provider_id, sourceSession.model_id)
    console.log(`[DeepChatAgent] forked session created id=${newSessionId}`)

    // Copy messages up to and including the fork point
    const sourceMessages = await this.getMessages(sessionId)
    const forkPointIndex = sourceMessages.findIndex((m) => m.id === messageId)

    if (forkPointIndex === -1) {
      throw new Error(`Message ${messageId} not found in session ${sessionId}`)
    }

    // Copy messages up to fork point (inclusive)
    for (let i = 0; i <= forkPointIndex; i++) {
      const msg = sourceMessages[i]
      const newMessageId = nanoid()

      // Insert message into new session with new ID but same order_seq
      this.sqlitePresenter.deepchatMessagesTable.insert({
        id: newMessageId,
        sessionId: newSessionId,
        orderSeq: msg.orderSeq,
        role: msg.role,
        content: msg.content,
        status: msg.status
      })
    }

    console.log(
      `[DeepChatAgent] forked ${forkPointIndex + 1} messages to new session ${newSessionId}`
    )

    return newSessionId
  }
}
