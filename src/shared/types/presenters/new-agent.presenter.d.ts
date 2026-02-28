import type {
  Agent,
  CreateSessionInput,
  SessionWithState,
  ChatMessageRecord,
  PermissionMode
} from '../agent-interface'
import type { PermissionWhitelistRule } from '../permission'

export interface INewAgentPresenter {
  createSession(input: CreateSessionInput, webContentsId: number): Promise<SessionWithState>
  sendMessage(sessionId: string, content: string): Promise<void>
  getSessionList(filters?: { agentId?: string; projectDir?: string }): Promise<SessionWithState[]>
  getSession(sessionId: string): Promise<SessionWithState | null>
  getMessages(sessionId: string): Promise<ChatMessageRecord[]>
  getMessageIds(sessionId: string): Promise<string[]>
  getMessage(messageId: string): Promise<ChatMessageRecord | null>
  activateSession(webContentsId: number, sessionId: string): Promise<void>
  deactivateSession(webContentsId: number): Promise<void>
  getActiveSession(webContentsId: number): Promise<SessionWithState | null>
  getAgents(): Promise<Agent[]>
  deleteSession(sessionId: string): Promise<void>
  cancelGeneration(sessionId: string): Promise<void>
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
  getSessionPermissionMode(sessionId: string): Promise<PermissionMode | null>
  editUserMessage(sessionId: string, messageId: string, newContent: string): Promise<void>
  forkSessionFromMessage(sessionId: string, messageId: string): Promise<string>
  // Whitelist management
  addToWhitelist(sessionId: string, toolName: string, pathPattern: string): Promise<string>
  removeFromWhitelist(sessionId: string, ruleId: string): Promise<boolean>
  getWhitelist(sessionId: string): Promise<PermissionWhitelistRule[]>
  checkWhitelist(sessionId: string, toolName: string, path: string): Promise<boolean>
  // Path access control (T4)
  checkPathAccess(sessionId: string, path: string): Promise<{ allowed: boolean; reason?: string }>
  // Workspace binding
  bindWorkspace(sessionId: string): Promise<string | null>
  updateSession(
    sessionId: string,
    fields: Partial<Pick<SessionWithState, 'title' | 'projectDir' | 'isPinned' | 'permissionMode'>>
  ): Promise<void>
  // Permission handling
  handlePermissionResponse(
    sessionId: string,
    toolCallId: string,
    granted: boolean,
    permissionType: 'read' | 'write' | 'all',
    remember: boolean
  ): Promise<void>
}
