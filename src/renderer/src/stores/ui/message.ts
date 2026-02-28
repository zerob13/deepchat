import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { usePresenter } from '@/composables/usePresenter'
import { STREAM_EVENTS } from '@/events'
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
  
  // Track generating state per conversation
  const generatingMessageIds = ref<Set<string>>(new Set())
  const messageBlocks = ref<Map<string, AssistantMessageBlock[]>>(new Map())

  // --- Getters ---
  const messages = computed(() => {
    return messageIds.value
      .map((id) => messageCache.value.get(id))
      .filter((m): m is ChatMessageRecord => m !== undefined)
  })

  // --- Actions ---

  async function loadMessages(sessionId: string): Promise<void> {
    try {
      const result = await newAgentPresenter.getMessages(sessionId)
      messageCache.value.clear()
      messageIds.value = []
      for (const msg of result) {
        messageCache.value.set(msg.id, msg)
        messageIds.value.push(msg.id)
      }
      console.log(
        '[MessageStore] loadMessages:',
        result.map((m) => ({ seq: m.orderSeq, role: m.role }))
      )
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
    const id = `__optimistic_user_${Date.now()}`
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

  function clear(): void {
    messageIds.value = []
    messageCache.value.clear()
    isStreaming.value = false
    streamingBlocks.value = []
    currentStreamSessionId.value = null
  }

  // --- Event Listeners ---

  window.electron.ipcRenderer.on(
    STREAM_EVENTS.RESPONSE,
    (_: unknown, msg: { conversationId: string; blocks: AssistantMessageBlock[] }) => {
      const sessionStore = useSessionStore()
      if (msg.conversationId === sessionStore.activeSessionId) {
        // Store blocks for this conversation
        messageBlocks.value.set(msg.conversationId, msg.blocks)
        
        // Mark as generating
        generatingMessageIds.value.add(msg.conversationId)
        
        // Update legacy state for backward compatibility
        isStreaming.value = true
        currentStreamSessionId.value = msg.conversationId
        streamingBlocks.value = msg.blocks
        
        // Trigger UI update
        // messageVersion.value++ // Uncomment if messageVersion exists
      }
    }
  )

  window.electron.ipcRenderer.on(
    STREAM_EVENTS.END,
    (_: unknown, msg: { conversationId: string }) => {
      const sessionStore = useSessionStore()
      if (msg.conversationId === sessionStore.activeSessionId) {
        // Clear generating state
        generatingMessageIds.value.delete(msg.conversationId)
        messageBlocks.value.delete(msg.conversationId)
        
        // Clear legacy state
        isStreaming.value = false
        streamingBlocks.value = []
        currentStreamSessionId.value = null
        
        // Reload messages from DB to get finalized content
        loadMessages(msg.conversationId)
      }
    }
  )

  window.electron.ipcRenderer.on(
    STREAM_EVENTS.ERROR,
    (_: unknown, msg: { conversationId: string; error: string }) => {
      const sessionStore = useSessionStore()
      if (msg.conversationId === sessionStore.activeSessionId) {
        // Clear generating state
        generatingMessageIds.value.delete(msg.conversationId)
        messageBlocks.value.delete(msg.conversationId)
        
        // Clear legacy state
        isStreaming.value = false
        streamingBlocks.value = []
        currentStreamSessionId.value = null
        
        // Reload messages from DB to get error state
        loadMessages(msg.conversationId)
      }
    }
  )

  // Add method to get blocks for a conversation
  function getBlocks(conversationId: string): AssistantMessageBlock[] {
    return messageBlocks.value.get(conversationId) || []
  }

  // Add method to check if generating
  function isGenerating(conversationId: string): boolean {
    return generatingMessageIds.value.has(conversationId)
  }

  return {
    messageIds,
    messageCache,
    isStreaming,
    streamingBlocks,
    messages,
    loadMessages,
    getMessage,
    addOptimisticUserMessage,
    clear,
    getBlocks,
    isGenerating
  }
})
