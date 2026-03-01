import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { usePresenter } from '@/composables/usePresenter'
import { STREAM_EVENTS, SESSION_EVENTS } from '@/events'
import type { ChatMessageRecord, AssistantMessageBlock } from '@shared/types/agent-interface'
import { useSessionStore } from './session'

// --- Store ---

export const useMessageStore = defineStore('message', () => {
  const newAgentPresenter = usePresenter('newAgentPresenter')

  // --- State ---
  const messageIds = ref<string[]>([])
  const messageCache = ref<Map<string, ChatMessageRecord>>(new Map())
  const isStreaming = ref(false)
  const streamingBlocks = ref<AssistantMessageBlock[]>([])
  const currentStreamSessionId = ref<string | null>(null)

  // Track optimistic message IDs for proper cleanup/merging
  // Map: optimisticId -> { sessionId, content }
  const optimisticMessages = ref<Map<string, { sessionId: string; text: string }>>(new Map())

  // --- Getters ---
  const messages = computed(() => {
    return messageIds.value
      .map((id) => messageCache.value.get(id))
      .filter((m): m is ChatMessageRecord => m !== undefined)
  })

  /**
   * Check if there are pending optimistic messages for a session
   */
  const hasOptimisticMessages = computed(() => {
    return (sessionId: string): boolean => {
      for (const [, data] of optimisticMessages.value) {
        if (data.sessionId === sessionId) return true
      }
      return false
    }
  })

  // --- Actions ---

  async function loadMessages(sessionId: string): Promise<void> {
    try {
      const result = await newAgentPresenter.getMessages(sessionId)
      messageCache.value.clear()
      messageIds.value = []

      // Clear optimistic messages for this session since we're loading real ones
      for (const [id, data] of optimisticMessages.value) {
        if (data.sessionId === sessionId) {
          optimisticMessages.value.delete(id)
        }
      }
      optimisticMessages.value = new Map(optimisticMessages.value)

      for (const msg of result) {
        messageCache.value.set(msg.id, msg)
        messageIds.value.push(msg.id)
      }
    } catch (e) {
      console.error('Failed to load messages:', e)
    }
  }

  async function getMessage(id: string): Promise<ChatMessageRecord | null> {
    const cached = messageCache.value.get(id)
    if (cached) return cached

    try {
      const msg = await newAgentPresenter.getMessage(id)
      if (msg) {
        messageCache.value.set(msg.id, msg)
      }
      return msg
    } catch (e) {
      console.error('Failed to get message:', e)
      return null
    }
  }

  /**
   * Add an optimistic user message to the local store so it appears immediately
   * in the UI without waiting for a backend round-trip or stream completion.
   * The optimistic record is replaced with the real DB record when loadMessages
   * is called at stream end.
   */
  function addOptimisticUserMessage(sessionId: string, text: string): void {
    const id = `__optimistic_user_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    // Track the optimistic message
    optimisticMessages.value.set(id, { sessionId, text })
    optimisticMessages.value = new Map(optimisticMessages.value)

    const record: ChatMessageRecord = {
      id,
      sessionId,
      orderSeq: messageIds.value.length + 1,
      role: 'user',
      content: JSON.stringify({ text, files: [], links: [], search: false, think: false }),
      status: 'sent',
      isContextEdge: 0,
      metadata: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    messageCache.value.set(id, record)
    messageIds.value.push(id)
  }

  /**
   * Merge optimistic messages with real messages from DB.
   * This is called when we receive real messages and need to replace optimistic ones.
   */
  function mergeOptimisticMessages(sessionId: string, realMessages: ChatMessageRecord[]): void {
    const optimisticIdsToRemove: string[] = []

    // Find optimistic messages for this session
    for (const [optimisticId, data] of optimisticMessages.value) {
      if (data.sessionId !== sessionId) continue

      // Try to find a matching real message by content
      const matchingReal = realMessages.find((realMsg) => {
        if (realMsg.role !== 'user') return false
        try {
          const parsed = JSON.parse(realMsg.content)
          return parsed.text === data.text
        } catch {
          return false
        }
      })

      if (matchingReal) {
        // Replace optimistic with real message
        const index = messageIds.value.indexOf(optimisticId)
        if (index !== -1) {
          messageIds.value[index] = matchingReal.id
          messageCache.value.delete(optimisticId)
          messageCache.value.set(matchingReal.id, matchingReal)
        }
        optimisticIdsToRemove.push(optimisticId)
      }
    }

    // Remove processed optimistic messages from tracking
    for (const id of optimisticIdsToRemove) {
      optimisticMessages.value.delete(id)
    }
    if (optimisticIdsToRemove.length > 0) {
      optimisticMessages.value = new Map(optimisticMessages.value)
    }
  }

  /**
   * Remove optimistic messages for a session (e.g., on cancel/error)
   */
  function removeOptimisticMessages(sessionId: string): void {
    const idsToRemove: string[] = []

    for (const [id, data] of optimisticMessages.value) {
      if (data.sessionId === sessionId) {
        idsToRemove.push(id)
        // Remove from display
        const index = messageIds.value.indexOf(id)
        if (index !== -1) {
          messageIds.value.splice(index, 1)
        }
        messageCache.value.delete(id)
      }
    }

    for (const id of idsToRemove) {
      optimisticMessages.value.delete(id)
    }

    if (idsToRemove.length > 0) {
      optimisticMessages.value = new Map(optimisticMessages.value)
    }
  }

  function clear(): void {
    messageIds.value = []
    messageCache.value.clear()
    isStreaming.value = false
    streamingBlocks.value = []
    currentStreamSessionId.value = null
    optimisticMessages.value.clear()
  }

  // --- Event Listeners ---

  window.electron.ipcRenderer.on(
    STREAM_EVENTS.RESPONSE,
    (_: unknown, msg: { conversationId: string; blocks: AssistantMessageBlock[] }) => {
      const sessionStore = useSessionStore()
      if (msg.conversationId === sessionStore.activeSessionId) {
        isStreaming.value = true
        currentStreamSessionId.value = msg.conversationId
        streamingBlocks.value = msg.blocks
      }
    }
  )

  window.electron.ipcRenderer.on(
    STREAM_EVENTS.END,
    (_: unknown, msg: { conversationId: string }) => {
      const sessionStore = useSessionStore()
      if (msg.conversationId === sessionStore.activeSessionId) {
        isStreaming.value = false
        streamingBlocks.value = []
        currentStreamSessionId.value = null
        // Reload messages from DB to get finalized content
        // This will also merge optimistic messages
        loadMessages(msg.conversationId)
      }
    }
  )

  window.electron.ipcRenderer.on(
    STREAM_EVENTS.ERROR,
    (_: unknown, msg: { conversationId: string; error: string }) => {
      const sessionStore = useSessionStore()
      if (msg.conversationId === sessionStore.activeSessionId) {
        isStreaming.value = false
        streamingBlocks.value = []
        currentStreamSessionId.value = null
        // Reload messages from DB to get error state
        loadMessages(msg.conversationId)
      }
    }
  )

  // Listen to session status changes to handle cancel/error states
  window.electron.ipcRenderer.on(
    SESSION_EVENTS.STATUS_CHANGED,
    (_: unknown, msg: { sessionId: string; status: string }) => {
      const sessionStore = useSessionStore()
      if (msg.sessionId === sessionStore.activeSessionId) {
        if (msg.status === 'idle' || msg.status === 'error') {
          // Generation ended (completed, cancelled, or errored)
          // Reload to get final state
          loadMessages(msg.sessionId)
        }
      }
    }
  )

  return {
    messageIds,
    messageCache,
    isStreaming,
    streamingBlocks,
    messages,
    optimisticMessages,
    hasOptimisticMessages,
    loadMessages,
    getMessage,
    addOptimisticUserMessage,
    mergeOptimisticMessages,
    removeOptimisticMessages,
    clear
  }
})
