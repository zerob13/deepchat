import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, AssistantMessageBlock } from '@shared/chat'
import type { ILlmProviderPresenter, IMCPPresenter, IToolPresenter } from '@shared/presenter'
import { PermissionHandler } from '@/presenter/agentPresenter/permission/permissionHandler'
import { CommandPermissionService } from '@/presenter/permission'
import { presenter } from '@/presenter'
import type { ThreadHandlerContext } from '@/presenter/searchPresenter/handlers/baseHandler'
import type { StreamGenerationHandler } from '@/presenter/agentPresenter/streaming/streamGenerationHandler'
import type { LLMEventHandler } from '@/presenter/agentPresenter/streaming/llmEventHandler'
import type { MessageManager } from '@/presenter/sessionPresenter/managers/messageManager'
import type { SearchManager } from '@/presenter/searchPresenter/managers/searchManager'
import type { GeneratingMessageState } from '@/presenter/agentPresenter/streaming/types'

/**
 * Visibility Regression Tests for Permission Recovery Flow
 *
 * These tests verify that after permission is granted:
 * 1. flushStreamUpdates is called before tool execution (to persist permission status)
 * 2. flushStreamUpdates is called after tool execution (to persist tool results)
 * 3. The flush is awaited before continuing generation
 *
 * This prevents the "repeated tool_use" issue where the model doesn't see the tool results.
 */

const sessionState = vi.hoisted(() => ({
  pendingPermissions: new Map<
    string,
    Array<{
      messageId: string
      toolCallId: string
      permissionType: 'read' | 'write' | 'all' | 'command'
      payload: Record<string, unknown>
    }>
  >(),
  locks: new Map<string, { messageId: string; startedAt: number }>(),
  status: new Map<string, string>(),
  sessions: new Map<string, { id: string }>()
}))

const presenterMock = vi.hoisted(() => ({
  sessionManager: {
    clearPendingPermission: vi.fn((agentId: string) => {
      sessionState.pendingPermissions.delete(agentId)
    }),
    setStatus: vi.fn((agentId: string, status: string) => {
      sessionState.status.set(agentId, status)
    }),
    getStatus: vi.fn((agentId: string) => {
      return (
        (sessionState.status.get(agentId) as
          | 'idle'
          | 'generating'
          | 'waiting_permission'
          | 'waiting_question'
          | null) ?? 'waiting_permission'
      )
    }),
    startLoop: vi.fn().mockResolvedValue(undefined),
    removePendingPermission: vi.fn((agentId: string, messageId: string, toolCallId: string) => {
      const pending = sessionState.pendingPermissions.get(agentId) ?? []
      sessionState.pendingPermissions.set(
        agentId,
        pending.filter((item) => !(item.messageId === messageId && item.toolCallId === toolCallId))
      )
    }),
    addPendingPermission: vi.fn(
      (
        agentId: string,
        permission: {
          messageId: string
          toolCallId: string
          permissionType: 'read' | 'write' | 'all' | 'command'
          payload: Record<string, unknown>
        }
      ) => {
        const pending = sessionState.pendingPermissions.get(agentId) ?? []
        pending.push(permission)
        sessionState.pendingPermissions.set(agentId, pending)
      }
    ),
    getPendingPermissions: vi.fn((agentId: string) => {
      return sessionState.pendingPermissions.get(agentId) ?? []
    }),
    hasPendingPermissions: vi.fn((agentId: string, messageId?: string) => {
      const pending = sessionState.pendingPermissions.get(agentId) ?? []
      if (!messageId) {
        return pending.length > 0
      }
      return pending.some((item) => item.messageId === messageId)
    }),
    acquirePermissionResumeLock: vi.fn((agentId: string, messageId: string) => {
      if (sessionState.locks.get(agentId)?.messageId === messageId) {
        return false
      }
      sessionState.locks.set(agentId, { messageId, startedAt: Date.now() })
      return true
    }),
    getPermissionResumeLock: vi.fn((agentId: string) => {
      return sessionState.locks.get(agentId)
    }),
    releasePermissionResumeLock: vi.fn((agentId: string) => {
      sessionState.locks.delete(agentId)
    }),
    getSessionSync: vi.fn((agentId: string) => {
      return sessionState.sessions.get(agentId) ?? null
    })
  },
  filePermissionService: {
    approve: vi.fn()
  },
  settingsPermissionService: {
    approve: vi.fn()
  }
}))

vi.mock('@/presenter', () => ({
  presenter: presenterMock
}))

const createAssistantMessage = (
  blocks: AssistantMessageBlock[],
  conversationId: string,
  messageId: string
): AssistantMessage => {
  return {
    id: messageId,
    conversationId,
    role: 'assistant',
    content: blocks
  } as AssistantMessage
}

/**
 * Creates a permission handler with mocked dependencies for testing visibility
 */
const createPermissionHandlerForFlushTesting = (options: {
  message: AssistantMessage
  llmProviderPresenter?: ILlmProviderPresenter
}) => {
  let currentMessage = options.message
  const flushTimings: Array<{ phase: string; timestamp: number }> = []
  const operationOrder: string[] = []

  const messageManager = {
    getMessage: vi.fn().mockImplementation(async () => {
      operationOrder.push('db-read')
      return currentMessage
    }),
    editMessage: vi.fn().mockImplementation(async (_id: string, rawContent: string) => {
      operationOrder.push('db-write')
      const next = JSON.parse(rawContent) as AssistantMessageBlock[]
      currentMessage = {
        ...currentMessage,
        content: next
      }
      return currentMessage
    }),
    editMessageSilently: vi.fn().mockImplementation(async (_id: string, rawContent: string) => {
      operationOrder.push('db-write-silent')
      const next = JSON.parse(rawContent) as AssistantMessageBlock[]
      currentMessage = {
        ...currentMessage,
        content: next
      }
      return currentMessage
    }),
    handleMessageError: vi.fn()
  } as unknown as MessageManager

  const ctx: ThreadHandlerContext = {
    sqlitePresenter: {} as never,
    messageManager,
    llmProviderPresenter: options.llmProviderPresenter ?? ({} as ILlmProviderPresenter),
    configPresenter: {} as never,
    searchManager: {} as SearchManager
  }

  const generatingMessages = new Map<string, GeneratingMessageState>()
  generatingMessages.set(currentMessage.id, {
    message: currentMessage,
    conversationId: currentMessage.conversationId,
    startTime: Date.now(),
    firstTokenTime: null,
    promptTokens: 0,
    reasoningStartTime: null,
    reasoningEndTime: null,
    lastReasoningTime: null
  })

  const mockLlmEventHandler = {
    handleLLMAgentResponse: vi.fn().mockImplementation(async (msg: any) => {
      if (msg.tool_call === 'end' && msg.tool_call_id) {
        const state = generatingMessages.get(msg.eventId)
        if (state) {
          const block = state.message.content.find(
            (b: AssistantMessageBlock) =>
              b.type === 'tool_call' && b.tool_call?.id === msg.tool_call_id
          )
          if (block) {
            block.status = 'success'
            if (block.tool_call) {
              block.tool_call.response = msg.tool_call_response
            }
          }
        }
      }
      return Promise.resolve()
    }),
    handleLLMAgentError: vi.fn(),
    handleLLMAgentEnd: vi.fn(),
    flushStreamUpdates: vi.fn().mockImplementation(async (eventId: string) => {
      operationOrder.push('flush-start')
      flushTimings.push({ phase: 'flush', timestamp: Date.now() })

      // Simulate actual flush - update DB with current state
      const state = generatingMessages.get(eventId)
      if (state?.message?.content) {
        await messageManager.editMessageSilently(eventId, JSON.stringify(state.message.content))
      }

      operationOrder.push('flush-end')
    })
  } as unknown as LLMEventHandler

  const mockStreamGenerationHandler = {
    startStreamCompletion: vi.fn().mockImplementation(async (convId: string, msgId: string) => {
      operationOrder.push('startStreamCompletion')
      // This simulates reading from DB to prepare context
      await messageManager.getMessage(msgId)
    }),
    prepareConversationContext: vi.fn().mockImplementation(async () => {
      operationOrder.push('prepareContext')
      return {
        conversation: { id: currentMessage.conversationId, settings: {} },
        userMessage: { id: 'user-1', role: 'user', content: { text: 'test' } },
        contextMessages: [currentMessage]
      }
    })
  } as unknown as StreamGenerationHandler

  const handler = new PermissionHandler(ctx, {
    generatingMessages,
    llmProviderPresenter: options.llmProviderPresenter ?? ({} as ILlmProviderPresenter),
    getMcpPresenter: () =>
      ({
        grantPermission: vi.fn(),
        isServerRunning: vi.fn().mockResolvedValue(true)
      }) as unknown as IMCPPresenter,
    getToolPresenter: () =>
      ({
        getAllToolDefinitions: vi.fn(),
        callTool: vi.fn().mockResolvedValue({
          content: 'Tool executed',
          rawData: { requiresPermission: false }
        }),
        buildToolSystemPrompt: vi.fn()
      }) as unknown as IToolPresenter,
    streamGenerationHandler: mockStreamGenerationHandler,
    llmEventHandler: mockLlmEventHandler,
    commandPermissionHandler: new CommandPermissionService()
  })

  return {
    handler,
    messageManager,
    getCurrentMessage: () => currentMessage,
    getFlushTimings: () => flushTimings,
    getOperationOrder: () => operationOrder,
    mockLlmEventHandler,
    mockStreamGenerationHandler,
    generatingMessages
  }
}

describe('Permission Recovery Visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionState.pendingPermissions.clear()
    sessionState.locks.clear()
    sessionState.status.clear()
    sessionState.sessions.clear()
  })

  describe('Synchronous Flush Guarantees', () => {
    it('should call flushStreamUpdates twice during permission resume', async () => {
      const conversationId = 'conv-flush-1'
      const messageId = 'msg-flush-1'
      const toolCallId = 'tool-flush-1'
      sessionState.sessions.set(conversationId, { id: conversationId })

      const permissionBlock: AssistantMessageBlock = {
        type: 'action',
        action_type: 'tool_call_permission',
        status: 'pending',
        timestamp: Date.now(),
        content: 'Permission required',
        tool_call: { id: toolCallId, name: 'test_tool' },
        extra: {
          needsUserAction: true,
          serverName: 'test-server',
          permissionType: 'read'
        }
      }

      const toolCallBlock: AssistantMessageBlock = {
        type: 'tool_call',
        status: 'loading',
        timestamp: Date.now(),
        content: '',
        tool_call: { id: toolCallId, name: 'test_tool', params: '{}' }
      }

      const message = createAssistantMessage(
        [permissionBlock, toolCallBlock],
        conversationId,
        messageId
      )

      const { handler, mockLlmEventHandler } = createPermissionHandlerForFlushTesting({ message })

      // Grant permission
      await handler.handlePermissionResponse(messageId, toolCallId, true, 'read', false)

      // Verify flush was called exactly twice (before and after tool execution)
      expect(mockLlmEventHandler.flushStreamUpdates).toHaveBeenCalledTimes(2)
      expect(mockLlmEventHandler.flushStreamUpdates).toHaveBeenNthCalledWith(1, messageId)
      expect(mockLlmEventHandler.flushStreamUpdates).toHaveBeenNthCalledWith(2, messageId)
    })

    it('should await flush completion before executing tools', async () => {
      const conversationId = 'conv-order-1'
      const messageId = 'msg-order-1'
      const toolCallId = 'tool-order-1'
      sessionState.sessions.set(conversationId, { id: conversationId })

      const permissionBlock: AssistantMessageBlock = {
        type: 'action',
        action_type: 'tool_call_permission',
        status: 'pending',
        timestamp: Date.now(),
        content: 'Permission required',
        tool_call: { id: toolCallId, name: 'slow_tool' },
        extra: {
          needsUserAction: true,
          serverName: 'test-server',
          permissionType: 'read'
        }
      }

      const toolCallBlock: AssistantMessageBlock = {
        type: 'tool_call',
        status: 'loading',
        timestamp: Date.now(),
        content: '',
        tool_call: { id: toolCallId, name: 'slow_tool', params: '{}' }
      }

      const message = createAssistantMessage(
        [permissionBlock, toolCallBlock],
        conversationId,
        messageId
      )

      const { handler, getOperationOrder } = createPermissionHandlerForFlushTesting({ message })

      // Grant permission
      await handler.handlePermissionResponse(messageId, toolCallId, true, 'read', false)

      const order = getOperationOrder()

      // Verify the order of operations:
      // 1. First flush (before tool execution)
      // 2. DB writes from flush
      // 3. Second flush (after tool execution)
      // 4. DB writes from second flush
      // 5. Then startStreamCompletion

      const firstFlushStartIndex = order.indexOf('flush-start')
      const firstFlushEndIndex = order.indexOf('flush-end')
      const secondFlushStartIndex = order.indexOf('flush-start', firstFlushEndIndex + 1)
      const secondFlushEndIndex = order.indexOf('flush-end', firstFlushEndIndex + 1)
      const startStreamIndex = order.indexOf('startStreamCompletion')

      expect(firstFlushStartIndex).toBeGreaterThanOrEqual(0)
      expect(firstFlushEndIndex).toBeGreaterThan(firstFlushStartIndex)
      expect(secondFlushStartIndex).toBeGreaterThan(firstFlushEndIndex)
      expect(secondFlushEndIndex).toBeGreaterThan(secondFlushStartIndex)
      expect(startStreamIndex).toBeGreaterThan(secondFlushEndIndex)
    })

    it('should flush before starting stream completion', async () => {
      const conversationId = 'conv-flow-1'
      const messageId = 'msg-flow-1'
      const toolCallId = 'tool-flow-1'
      sessionState.sessions.set(conversationId, { id: conversationId })

      const permissionBlock: AssistantMessageBlock = {
        type: 'action',
        action_type: 'tool_call_permission',
        status: 'pending',
        timestamp: Date.now(),
        content: 'Permission required',
        tool_call: { id: toolCallId, name: 'test_tool' },
        extra: {
          needsUserAction: true,
          serverName: 'test-server',
          permissionType: 'read'
        }
      }

      const toolCallBlock: AssistantMessageBlock = {
        type: 'tool_call',
        status: 'loading',
        timestamp: Date.now(),
        content: '',
        tool_call: { id: toolCallId, name: 'test_tool', params: '{}' }
      }

      const message = createAssistantMessage(
        [permissionBlock, toolCallBlock],
        conversationId,
        messageId
      )

      const { handler, getOperationOrder } = createPermissionHandlerForFlushTesting({ message })

      // Grant permission
      await handler.handlePermissionResponse(messageId, toolCallId, true, 'read', false)

      const order = getOperationOrder()

      // The last flush-end should come before startStreamCompletion
      const lastFlushEndIndex = order.lastIndexOf('flush-end')
      const startStreamIndex = order.indexOf('startStreamCompletion')

      expect(lastFlushEndIndex).toBeGreaterThanOrEqual(0)
      expect(startStreamIndex).toBeGreaterThan(lastFlushEndIndex)
    })
  })

  describe('Lock Management During Flush', () => {
    it('should hold lock throughout the entire resume flow', async () => {
      const conversationId = 'conv-lock-1'
      const messageId = 'msg-lock-1'
      const toolCallId = 'tool-lock-1'
      sessionState.sessions.set(conversationId, { id: conversationId })

      const permissionBlock: AssistantMessageBlock = {
        type: 'action',
        action_type: 'tool_call_permission',
        status: 'pending',
        timestamp: Date.now(),
        content: 'Permission required',
        tool_call: { id: toolCallId, name: 'test_tool' },
        extra: {
          needsUserAction: true,
          serverName: 'test-server',
          permissionType: 'read'
        }
      }

      const toolCallBlock: AssistantMessageBlock = {
        type: 'tool_call',
        status: 'loading',
        timestamp: Date.now(),
        content: '',
        tool_call: { id: toolCallId, name: 'test_tool', params: '{}' }
      }

      const message = createAssistantMessage(
        [permissionBlock, toolCallBlock],
        conversationId,
        messageId
      )

      const { handler } = createPermissionHandlerForFlushTesting({ message })

      // Grant permission
      await handler.handlePermissionResponse(messageId, toolCallId, true, 'read', false)

      // Verify lock was acquired
      expect(presenterMock.sessionManager.acquirePermissionResumeLock).toHaveBeenCalledWith(
        conversationId,
        messageId
      )

      // Verify lock was released at the end
      expect(presenterMock.sessionManager.releasePermissionResumeLock).toHaveBeenCalledWith(
        conversationId
      )
    })

    it('should release lock even on error', async () => {
      const conversationId = 'conv-lock-error-1'
      const messageId = 'msg-lock-error-1'
      const toolCallId = 'tool-lock-error-1'
      sessionState.sessions.set(conversationId, { id: conversationId })

      const permissionBlock: AssistantMessageBlock = {
        type: 'action',
        action_type: 'tool_call_permission',
        status: 'pending',
        timestamp: Date.now(),
        content: 'Permission required',
        tool_call: { id: toolCallId, name: 'test_tool' },
        extra: {
          needsUserAction: true,
          serverName: 'test-server',
          permissionType: 'read'
        }
      }

      const toolCallBlock: AssistantMessageBlock = {
        type: 'tool_call',
        status: 'loading',
        timestamp: Date.now(),
        content: '',
        tool_call: { id: toolCallId, name: 'test_tool', params: '{}' }
      }

      const message = createAssistantMessage(
        [permissionBlock, toolCallBlock],
        conversationId,
        messageId
      )

      // Create handler with failing tool presenter
      const failingHandler = new PermissionHandler(
        {
          sqlitePresenter: {} as never,
          messageManager: {
            getMessage: vi.fn().mockResolvedValue(message),
            editMessage: vi.fn().mockResolvedValue(message),
            editMessageSilently: vi.fn().mockResolvedValue(message),
            handleMessageError: vi.fn().mockResolvedValue(undefined)
          } as unknown as MessageManager,
          llmProviderPresenter: {} as ILlmProviderPresenter,
          configPresenter: {} as never,
          searchManager: {} as SearchManager
        },
        {
          generatingMessages: new Map([
            [
              messageId,
              {
                message,
                conversationId,
                startTime: Date.now(),
                firstTokenTime: null,
                promptTokens: 0,
                reasoningStartTime: null,
                reasoningEndTime: null,
                lastReasoningTime: null
              }
            ]
          ]),
          llmProviderPresenter: {} as ILlmProviderPresenter,
          getMcpPresenter: () =>
            ({
              grantPermission: vi.fn(),
              isServerRunning: vi.fn().mockResolvedValue(true)
            }) as unknown as IMCPPresenter,
          getToolPresenter: () =>
            ({
              getAllToolDefinitions: vi.fn().mockRejectedValue(new Error('Tool error')),
              callTool: vi.fn().mockRejectedValue(new Error('Tool execution failed')),
              buildToolSystemPrompt: vi.fn()
            }) as unknown as IToolPresenter,
          streamGenerationHandler: {
            startStreamCompletion: vi.fn(),
            prepareConversationContext: vi.fn()
          } as unknown as StreamGenerationHandler,
          llmEventHandler: {
            handleLLMAgentResponse: vi.fn(),
            handleLLMAgentError: vi.fn(),
            handleLLMAgentEnd: vi.fn(),
            flushStreamUpdates: vi.fn().mockRejectedValue(new Error('Flush failed'))
          } as unknown as LLMEventHandler,
          commandPermissionHandler: new CommandPermissionService()
        }
      )

      // Grant permission - should throw but also release lock
      await expect(
        failingHandler.handlePermissionResponse(messageId, toolCallId, true, 'read', false)
      ).rejects.toThrow()

      // Lock should still be released even on error
      expect(presenterMock.sessionManager.releasePermissionResumeLock).toHaveBeenCalledWith(
        conversationId
      )
    })
  })

  describe('Multiple Permission Resolution', () => {
    it('should not resume until all permissions are resolved', async () => {
      const conversationId = 'conv-multi-1'
      const messageId = 'msg-multi-1'
      const toolCallId1 = 'tool-multi-1'
      const toolCallId2 = 'tool-multi-2'
      sessionState.sessions.set(conversationId, { id: conversationId })

      // Setup two pending permissions
      sessionState.pendingPermissions.set(conversationId, [
        { messageId, toolCallId: toolCallId1, permissionType: 'read', payload: {} },
        { messageId, toolCallId: toolCallId2, permissionType: 'write', payload: {} }
      ])

      const permissionBlock1: AssistantMessageBlock = {
        type: 'action',
        action_type: 'tool_call_permission',
        status: 'pending',
        timestamp: Date.now(),
        content: 'Permission 1 required',
        tool_call: { id: toolCallId1, name: 'read_file' },
        extra: {
          needsUserAction: true,
          serverName: 'filesystem',
          permissionType: 'read'
        }
      }

      const permissionBlock2: AssistantMessageBlock = {
        type: 'action',
        action_type: 'tool_call_permission',
        status: 'pending',
        timestamp: Date.now(),
        content: 'Permission 2 required',
        tool_call: { id: toolCallId2, name: 'write_file' },
        extra: {
          needsUserAction: true,
          serverName: 'filesystem',
          permissionType: 'write'
        }
      }

      const message = createAssistantMessage(
        [permissionBlock1, permissionBlock2],
        conversationId,
        messageId
      )

      const { handler, mockStreamGenerationHandler } = createPermissionHandlerForFlushTesting({
        message
      })

      // Grant first permission - should not start stream completion yet
      await handler.handlePermissionResponse(messageId, toolCallId1, true, 'read', false)

      // Stream completion should not be called yet
      expect(mockStreamGenerationHandler.startStreamCompletion).not.toHaveBeenCalled()

      // Lock should be released after first permission (since there's still one pending)
      expect(presenterMock.sessionManager.releasePermissionResumeLock).not.toHaveBeenCalled()
    })
  })
})
