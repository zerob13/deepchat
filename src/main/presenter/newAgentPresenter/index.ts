import type {
  Agent,
  CreateSessionInput,
  SessionWithState,
  ChatMessageRecord
} from '@shared/types/agent-interface'
import type { IConfigPresenter } from '@shared/presenter'
import type { SQLitePresenter } from '../sqlitePresenter'
import type { DeepChatAgentPresenter } from '../deepchatAgentPresenter'
import { AgentRegistry } from './agentRegistry'
import { NewSessionManager } from './sessionManager'
import { NewMessageManager } from './messageManager'
import { eventBus, SendTarget } from '@/eventbus'
import { SESSION_EVENTS } from '@/events'

export class NewAgentPresenter {
  private agentRegistry: AgentRegistry
  private sessionManager: NewSessionManager
  private messageManager: NewMessageManager
  private configPresenter: IConfigPresenter

  constructor(
    deepchatAgent: DeepChatAgentPresenter,
    configPresenter: IConfigPresenter,
    sqlitePresenter: SQLitePresenter
  ) {
    this.configPresenter = configPresenter
    this.agentRegistry = new AgentRegistry()
    this.sessionManager = new NewSessionManager(sqlitePresenter)
    this.messageManager = new NewMessageManager(this.agentRegistry, this.sessionManager)

    // Register the built-in deepchat agent
    this.agentRegistry.register(
      { id: 'deepchat', name: 'DeepChat', type: 'deepchat', enabled: true },
      deepchatAgent
    )
  }

  // ---- IPC-facing methods ----

  async createSession(input: CreateSessionInput, webContentsId: number): Promise<SessionWithState> {
    const agentId = input.agentId || 'deepchat'
    console.log(`[NewAgentPresenter] createSession agent=${agentId} webContentsId=${webContentsId}`)

    const agent = this.agentRegistry.resolve(agentId)

    // Resolve provider/model
    const defaultModel = this.configPresenter.getDefaultModel()
    const providerId = input.providerId ?? defaultModel?.providerId ?? ''
    const modelId = input.modelId ?? defaultModel?.modelId ?? ''
    console.log(`[NewAgentPresenter] resolved provider=${providerId} model=${modelId}`)

    if (!providerId || !modelId) {
      throw new Error('No provider or model configured. Please set a default model in settings.')
    }

    // Create session record
    const title = input.message.slice(0, 50) || 'New Chat'
    const sessionId = this.sessionManager.create(agentId, title, input.projectDir ?? null)
    console.log(`[NewAgentPresenter] session created id=${sessionId} title="${title}"`)

    // Initialize agent-side session
    await agent.initSession(sessionId, { providerId, modelId })
    console.log(`[NewAgentPresenter] agent.initSession done`)

    // Bind to window and emit activated
    this.sessionManager.bindWindow(webContentsId, sessionId)
    eventBus.sendToRenderer(SESSION_EVENTS.ACTIVATED, SendTarget.ALL_WINDOWS, {
      webContentsId,
      sessionId
    })
    eventBus.sendToRenderer(SESSION_EVENTS.LIST_UPDATED, SendTarget.ALL_WINDOWS)

    // Process the first message (non-blocking)
    console.log(`[NewAgentPresenter] firing processMessage (non-blocking)`)
    agent.processMessage(sessionId, input.message).catch((err) => {
      console.error('[NewAgentPresenter] processMessage failed:', err)
    })

    // Return enriched session
    const state = await agent.getSessionState(sessionId)
    const sessionRecord = this.sessionManager.get(sessionId)
    return {
      id: sessionId,
      agentId,
      title,
      projectDir: input.projectDir ?? null,
      isPinned: false,
      permissionMode: sessionRecord?.permissionMode ?? 'default',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: state?.status ?? 'idle',
      providerId: state?.providerId ?? providerId,
      modelId: state?.modelId ?? modelId
    }
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const session = this.sessionManager.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const agent = this.agentRegistry.resolve(session.agentId)
    await agent.processMessage(sessionId, content)
  }

  async getSessionList(filters?: {
    agentId?: string
    projectDir?: string
  }): Promise<SessionWithState[]> {
    const records = this.sessionManager.list(filters)
    const enriched: SessionWithState[] = []

    for (const record of records) {
      const agent = this.agentRegistry.resolve(record.agentId)
      const state = await agent.getSessionState(record.id)
      enriched.push({
        ...record,
        status: state?.status ?? 'idle',
        providerId: state?.providerId ?? '',
        modelId: state?.modelId ?? ''
      })
    }

    return enriched
  }

  async getSession(sessionId: string): Promise<SessionWithState | null> {
    const record = this.sessionManager.get(sessionId)
    if (!record) return null
    const agent = this.agentRegistry.resolve(record.agentId)
    const state = await agent.getSessionState(sessionId)
    return {
      ...record,
      status: state?.status ?? 'idle',
      providerId: state?.providerId ?? '',
      modelId: state?.modelId ?? ''
    }
  }

  async getMessages(sessionId: string): Promise<ChatMessageRecord[]> {
    return this.messageManager.getMessages(sessionId)
  }

  async getMessageIds(sessionId: string): Promise<string[]> {
    return this.messageManager.getMessageIds(sessionId)
  }

  async getMessage(messageId: string): Promise<ChatMessageRecord | null> {
    return this.messageManager.getMessage(messageId)
  }

  async activateSession(webContentsId: number, sessionId: string): Promise<void> {
    this.sessionManager.bindWindow(webContentsId, sessionId)
    eventBus.sendToRenderer(SESSION_EVENTS.ACTIVATED, SendTarget.ALL_WINDOWS, {
      webContentsId,
      sessionId
    })
  }

  async deactivateSession(webContentsId: number): Promise<void> {
    this.sessionManager.unbindWindow(webContentsId)
    eventBus.sendToRenderer(SESSION_EVENTS.DEACTIVATED, SendTarget.ALL_WINDOWS, {
      webContentsId
    })
  }

  async getActiveSession(webContentsId: number): Promise<SessionWithState | null> {
    const sessionId = this.sessionManager.getActiveSessionId(webContentsId)
    if (!sessionId) return null
    return this.getSession(sessionId)
  }

  async getAgents(): Promise<Agent[]> {
    return this.agentRegistry.getAll()
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessionManager.get(sessionId)
    if (!session) return
    const agent = this.agentRegistry.resolve(session.agentId)
    await agent.destroySession(sessionId)
    this.sessionManager.delete(sessionId)
    eventBus.sendToRenderer(SESSION_EVENTS.LIST_UPDATED, SendTarget.ALL_WINDOWS)
  }

  async cancelGeneration(sessionId: string): Promise<void> {
    const session = this.sessionManager.get(sessionId)
    if (!session) return
    const agent = this.agentRegistry.resolve(session.agentId)
    await agent.cancelGeneration(sessionId)
  }

  async setSessionPermissionMode(sessionId: string, mode: 'default' | 'full'): Promise<void> {
    this.sessionManager.setPermissionMode(sessionId, mode)
  }

  async getSessionPermissionMode(sessionId: string): Promise<'default' | 'full' | null> {
    return this.sessionManager.getPermissionMode(sessionId)
  }

  async bindWorkspace(sessionId: string): Promise<string | null> {
    // This method is called from renderer, which will trigger a file dialog
    // The actual dialog is handled by Electron's dialog.showOpenDialog
    // We return the selected path or null if cancelled
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Workspace Directory',
      defaultPath: require('os').homedir()
    })

    if (result.canceled || result.filePaths.length === 0) {
      console.log('[bindWorkspace] User cancelled directory selection')
      return null
    }

    const selectedPath = result.filePaths[0]
    console.log('[bindWorkspace] Selected path:', selectedPath)

    // Update session with projectDir
    await this.sessionManager.update(sessionId, { projectDir: selectedPath })
    console.log('[bindWorkspace] Updated session projectDir in DB')

    // Verify the update
    const updatedSession = this.sessionManager.get(sessionId)
    console.log('[bindWorkspace] Verified session projectDir:', updatedSession?.projectDir)

    return selectedPath
  }

  async updateSession(
    sessionId: string,
    fields: Partial<Pick<SessionWithState, 'title' | 'projectDir' | 'isPinned' | 'permissionMode'>>
  ): Promise<void> {
    await this.sessionManager.update(sessionId, fields)
  }

  async checkPathAccess(
    sessionId: string,
    path: string
  ): Promise<{
    allowed: boolean
    reason?: string
  }> {
    const session = this.sessionManager.get(sessionId)
    if (!session) {
      return { allowed: false, reason: 'Session not found' }
    }

    const { validatePathAccess } = await import('@/utils/pathUtils')
    const validation = validatePathAccess(path, session.projectDir || '/')

    if (!validation.valid) {
      return { allowed: false, reason: validation.error }
    }

    return { allowed: true }
  }

  async editUserMessage(sessionId: string, messageId: string, newContent: string): Promise<void> {
    const session = this.sessionManager.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    const agent = this.agentRegistry.resolve(session.agentId)
    await agent.editUserMessage(sessionId, messageId, newContent)
  }

  async forkSessionFromMessage(sessionId: string, messageId: string): Promise<string> {
    const session = this.sessionManager.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    const agent = this.agentRegistry.resolve(session.agentId)
    const newSessionId = await agent.forkSessionFromMessage(sessionId, messageId)

    // Verify the forked session exists
    const newSessionRecord = this.sessionManager.get(newSessionId)
    if (!newSessionRecord) {
      throw new Error(`Forked session not found: ${newSessionId}`)
    }

    return newSessionId
  }

  // Whitelist management
  async addToWhitelist(sessionId: string, toolName: string, pathPattern: string): Promise<string> {
    return this.sessionManager.addToWhitelist(sessionId, toolName, pathPattern)
  }

  async removeFromWhitelist(sessionId: string, ruleId: string): Promise<boolean> {
    // Verify the rule belongs to this session
    const rules = await this.getWhitelist(sessionId)
    const rule = rules.find((r) => r.id === ruleId)
    if (!rule) {
      throw new Error(`Whitelist rule not found: ${ruleId}`)
    }
    return this.sessionManager.removeFromWhitelist(ruleId)
  }

  async getWhitelist(sessionId: string): Promise<
    Array<{
      id: string
      sessionId: string
      toolName: string
      pathPattern: string
      createdAt: number
    }>
  > {
    return this.sessionManager.getWhitelist(sessionId)
  }

  async checkWhitelist(sessionId: string, toolName: string, path: string): Promise<boolean> {
    return this.sessionManager.checkWhitelist(sessionId, toolName, path)
  }

  async handlePermissionResponse(
    messageId: string,
    toolCallId: string,
    granted: boolean,
    permissionType: 'read' | 'write' | 'all',
    remember: boolean
  ): Promise<void> {
    const agent = this.agentRegistry.resolve('deepchat')
    if (!agent) {
      throw new Error('DeepChat agent not found')
    }
    // Extract sessionId from message
    const message = await (agent as any).messageStore.getMessage(messageId)
    if (!message) {
      throw new Error(`Message not found: ${messageId}`)
    }
    const sessionId = message.conversationId
    return (agent as any).handlePermissionResponse(
      sessionId,
      messageId,
      toolCallId,
      granted,
      permissionType,
      remember
    )
  }
}
