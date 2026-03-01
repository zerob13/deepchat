import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ComputedRef } from 'vue'
import { usePresenter } from '@/composables/usePresenter'
import { SESSION_EVENTS, CONVERSATION_EVENTS, STREAM_EVENTS } from '@/events'
import type { SessionWithState, CreateSessionInput } from '@shared/types/agent-interface'
import { usePageRouterStore } from './pageRouter'
import { useChatStore } from '@/stores/chat'

// --- Type Definitions ---

export type UISessionStatus = 'completed' | 'working' | 'error' | 'none'

export interface UISession {
  id: string
  title: string
  agentId: string
  status: UISessionStatus
  projectDir: string
  providerId: string
  modelId: string
  createdAt: number
  updatedAt: number
}

export interface SessionGroup {
  label: string
  sessions: UISession[]
}

export type GroupMode = 'time' | 'project'

// --- Helper Functions ---

function mapSessionStatus(status: string): UISessionStatus {
  switch (status) {
    case 'generating':
    case 'waiting_permission':
    case 'waiting_question':
      return 'working'
    case 'error':
      return 'error'
    case 'idle':
    case 'paused':
      return 'none'
    default:
      return 'none'
  }
}

function mapToUISession(session: SessionWithState): UISession {
  return {
    id: session.id,
    title: session.title,
    agentId: session.agentId,
    status: mapSessionStatus(session.status),
    projectDir: session.projectDir ?? '',
    providerId: session.providerId,
    modelId: session.modelId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}

function startOfDay(timestamp: number): number {
  const d = new Date(timestamp)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function groupByTime(sessions: UISession[]): SessionGroup[] {
  const now = Date.now()
  const today = startOfDay(now)
  const yesterday = startOfDay(now - 86400000)
  const lastWeek = startOfDay(now - 7 * 86400000)

  const groups: Record<string, UISession[]> = {
    Today: [],
    Yesterday: [],
    'Last Week': [],
    Older: []
  }

  for (const s of sessions) {
    if (s.updatedAt >= today) groups['Today'].push(s)
    else if (s.updatedAt >= yesterday) groups['Yesterday'].push(s)
    else if (s.updatedAt >= lastWeek) groups['Last Week'].push(s)
    else groups['Older'].push(s)
  }

  return Object.entries(groups)
    .filter(([, sessions]) => sessions.length > 0)
    .map(([label, sessions]) => ({ label, sessions }))
}

function groupByProject(sessions: UISession[]): SessionGroup[] {
  const projectMap = new Map<string, UISession[]>()
  for (const session of sessions) {
    const dir = session.projectDir || 'No Project'
    if (!projectMap.has(dir)) projectMap.set(dir, [])
    projectMap.get(dir)!.push(session)
  }
  return Array.from(projectMap.entries()).map(([dir, sessions]) => ({
    label: dir.split('/').pop() ?? dir,
    sessions
  }))
}

// --- Store ---

export const useSessionStore = defineStore('session', () => {
  const newAgentPresenter = usePresenter('newAgentPresenter')
  const pageRouter = usePageRouterStore()

  // --- State ---
  const sessions = ref<UISession[]>([])
  const activeSessionId = ref<string | null>(null)
  const groupMode = ref<GroupMode>('time')
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Track generating session IDs for UI state (disable input, show stop button)
  const generatingSessionIds = ref<Set<string>>(new Set())

  // --- Getters ---
  const activeSession: ComputedRef<UISession | undefined> = computed(() =>
    sessions.value.find((s) => s.id === activeSessionId.value)
  )

  const hasActiveSession: ComputedRef<boolean> = computed(() => activeSessionId.value !== null)

  const sessionGroups: ComputedRef<SessionGroup[]> = computed(() => getFilteredGroups(null))

  /**
   * Check if a specific session is currently generating
   */
  const isSessionGenerating = computed(() => {
    return (sessionId: string): boolean => generatingSessionIds.value.has(sessionId)
  })

  /**
   * Check if the active session is currently generating
   */
  const isActiveSessionGenerating: ComputedRef<boolean> = computed(() => {
    if (!activeSessionId.value) return false
    return generatingSessionIds.value.has(activeSessionId.value)
  })

  // --- Actions ---

  async function fetchSessions(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await newAgentPresenter.getSessionList()
      sessions.value = result.map(mapToUISession)
    } catch (e) {
      error.value = `Failed to load sessions: ${e}`
    } finally {
      loading.value = false
    }
  }

  async function createSession(input: CreateSessionInput): Promise<void> {
    error.value = null
    try {
      const webContentsId = window.api.getWebContentsId()
      const session = await newAgentPresenter.createSession(input, webContentsId)
      activeSessionId.value = session.id
      await fetchSessions()
      pageRouter.goToChat(session.id)
    } catch (e) {
      error.value = `Failed to create session: ${e}`
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    error.value = null
    try {
      const webContentsId = window.api.getWebContentsId()
      await newAgentPresenter.activateSession(webContentsId, sessionId)
      pageRouter.goToChat(sessionId)
      // Note: loadChatConfig is called by CONVERSATION_EVENTS.ACTIVATED handler in chat.ts
      // We don't call it here to avoid double loading
    } catch (e) {
      error.value = `Failed to select session: ${e}`
    }
  }

  async function closeSession(): Promise<void> {
    error.value = null
    try {
      const webContentsId = window.api.getWebContentsId()
      await newAgentPresenter.deactivateSession(webContentsId)
      activeSessionId.value = null
      pageRouter.goToNewThread()
      // Clear chat config when leaving session (will be reloaded from defaultModel on NewThreadPage)
      const chatStore = useChatStore()
      chatStore.chatConfig = {
        systemPrompt: '',
        temperature: 0.7,
        contextLength: 32000,
        maxTokens: 8000,
        providerId: '',
        modelId: '',
        artifacts: 0,
        enabledMcpTools: [],
        thinkingBudget: undefined,
        reasoningEffort: undefined,
        verbosity: undefined,
        selectedVariantsMap: {},
        acpWorkdirMap: {},
        agentWorkspacePath: null
      }
    } catch (e) {
      error.value = `Failed to close session: ${e}`
    }
  }

  async function sendMessage(sessionId: string, content: string): Promise<void> {
    error.value = null
    try {
      // Add to generating set immediately for optimistic UI feedback
      generatingSessionIds.value.add(sessionId)
      generatingSessionIds.value = new Set(generatingSessionIds.value)
      await newAgentPresenter.sendMessage(sessionId, content)
    } catch (e) {
      // On error, remove from generating set
      generatingSessionIds.value.delete(sessionId)
      generatingSessionIds.value = new Set(generatingSessionIds.value)
      error.value = `Failed to send message: ${e}`
      throw e
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    error.value = null
    try {
      await newAgentPresenter.deleteSession(sessionId)
      if (activeSessionId.value === sessionId) {
        activeSessionId.value = null
        pageRouter.goToNewThread()
      }
      await fetchSessions()
    } catch (e) {
      error.value = `Failed to delete session: ${e}`
    }
  }

  /**
   * Cancel ongoing generation for a session
   */
  async function cancelGenerating(sessionId: string): Promise<void> {
    if (!sessionId) return
    error.value = null
    try {
      await newAgentPresenter.cancelGeneration(sessionId)
      // The generating state will be cleared when we receive the END/ERROR event
      // But we can optimistically remove it for immediate UI feedback
      generatingSessionIds.value.delete(sessionId)
      generatingSessionIds.value = new Set(generatingSessionIds.value)
    } catch (e) {
      console.error('[SessionStore] Failed to cancel generation:', e)
      error.value = `Failed to cancel generation: ${e}`
    }
  }

  /**
   * Add a session to the generating set
   */
  function addGeneratingSession(sessionId: string): void {
    generatingSessionIds.value.add(sessionId)
    generatingSessionIds.value = new Set(generatingSessionIds.value)
  }

  /**
   * Remove a session from the generating set
   */
  function removeGeneratingSession(sessionId: string): void {
    generatingSessionIds.value.delete(sessionId)
    generatingSessionIds.value = new Set(generatingSessionIds.value)
  }

  async function renameSession(sessionId: string, title: string): Promise<void> {
    error.value = null
    try {
      await newAgentPresenter.renameSession(sessionId, title)
      await fetchSessions()
    } catch (e) {
      error.value = `Failed to rename session: ${e}`
    }
  }

  async function toggleSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
    error.value = null
    try {
      await newAgentPresenter.toggleSessionPinned(sessionId, pinned)
      await fetchSessions()
    } catch (e) {
      error.value = `Failed to update session pin status: ${e}`
    }
  }

  function toggleGroupMode(): void {
    groupMode.value = groupMode.value === 'time' ? 'project' : 'time'
  }

  function getFilteredGroups(agentId: string | null): SessionGroup[] {
    const grouped =
      groupMode.value === 'time' ? groupByTime(sessions.value) : groupByProject(sessions.value)

    if (agentId === null) return grouped

    return grouped
      .map((group) => ({
        label: group.label,
        sessions: group.sessions.filter((s) => s.agentId === agentId)
      }))
      .filter((group) => group.sessions.length > 0)
  }

  // --- Event Listeners ---

  // Primary: SESSION_EVENTS - new event system (session-centric)
  window.electron.ipcRenderer.on(SESSION_EVENTS.LIST_UPDATED, () => {
    fetchSessions()
  })

  window.electron.ipcRenderer.on(
    SESSION_EVENTS.ACTIVATED,
    (_: unknown, msg: { webContentsId: number; sessionId: string }) => {
      const myId = window.api.getWebContentsId()
      if (msg.webContentsId === myId) {
        activeSessionId.value = msg.sessionId
      }
    }
  )

  window.electron.ipcRenderer.on(
    SESSION_EVENTS.DEACTIVATED,
    (_: unknown, msg: { webContentsId: number }) => {
      const myId = window.api.getWebContentsId()
      if (msg.webContentsId === myId) {
        activeSessionId.value = null
        pageRouter.goToNewThread()
      }
    }
  )

  window.electron.ipcRenderer.on(
    SESSION_EVENTS.STATUS_CHANGED,
    (_: unknown, msg: { sessionId: string; status: string }) => {
      const session = sessions.value.find((s) => s.id === msg.sessionId)
      if (session) {
        session.status = mapSessionStatus(msg.status)
      }
      // Update generating set based on status
      if (msg.status === 'generating') {
        generatingSessionIds.value.add(msg.sessionId)
        generatingSessionIds.value = new Set(generatingSessionIds.value)
      } else if (msg.status === 'idle' || msg.status === 'error') {
        generatingSessionIds.value.delete(msg.sessionId)
        generatingSessionIds.value = new Set(generatingSessionIds.value)
      }
    }
  )

  // Listen to stream events to track generation state
  window.electron.ipcRenderer.on(
    STREAM_EVENTS.END,
    (_: unknown, msg: { conversationId: string }) => {
      if (msg.conversationId) {
        generatingSessionIds.value.delete(msg.conversationId)
        generatingSessionIds.value = new Set(generatingSessionIds.value)
      }
    }
  )

  window.electron.ipcRenderer.on(
    STREAM_EVENTS.ERROR,
    (_: unknown, msg: { conversationId: string }) => {
      if (msg.conversationId) {
        generatingSessionIds.value.delete(msg.conversationId)
        generatingSessionIds.value = new Set(generatingSessionIds.value)
      }
    }
  )

  // DEPRECATED: CONVERSATION_EVENTS - old event system (conversation-centric)
  // Kept for backward compatibility during migration period.
  // TODO: Remove after full migration to newAgentPresenter/SESSION_EVENTS
  // Target removal: v1.x (when old sessionPresenter is fully deprecated)
  window.electron.ipcRenderer.on(CONVERSATION_EVENTS.LIST_UPDATED, () => {
    fetchSessions()
  })

  return {
    sessions,
    activeSessionId,
    groupMode,
    loading,
    error,
    generatingSessionIds,
    activeSession,
    sessionGroups,
    hasActiveSession,
    isSessionGenerating,
    isActiveSessionGenerating,
    fetchSessions,
    createSession,
    sendMessage,
    selectSession,
    closeSession,
    deleteSession,
    renameSession,
    toggleSessionPinned,
    cancelGenerating,
    addGeneratingSession,
    removeGeneratingSession,
    toggleGroupMode,
    getFilteredGroups
  }
})
