import { presenter } from '@/presenter'
import { eventBus, SendTarget } from '@/eventbus'
import { STREAM_EVENTS } from '@/events'
import type { AssistantMessageBlock } from '@shared/types/agent-interface'

/**
 * Handle user response to permission request
 * Called from renderer when user clicks Allow/Deny
 */
export async function handlePermissionResponse(
  sessionId: string,
  messageId: string,
  toolCallId: string,
  granted: boolean,
  permissionType: 'read' | 'write' | 'all',
  remember: boolean
): Promise<void> {
  console.log('[handlePermissionResponse] User response received', {
    sessionId,
    messageId,
    toolCallId,
    granted,
    permissionType,
    remember,
    resumingExecution: granted
  })

  const session = await presenter.newAgentPresenter.getSession(sessionId)
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  // Get the DeepChat agent instance directly
  const agent = (presenter as any).deepchatAgentPresenter
  if (!agent) {
    throw new Error(`DeepChat agent presenter not found`)
  }

  // Get the message from the message store
  const messageStore = agent.messageStore
  const message = await messageStore.getMessage(messageId)

  if (!message) {
    throw new Error(`Message not found: ${messageId}`)
  }

  // Parse the message content as blocks
  let blocks: AssistantMessageBlock[] = []
  try {
    blocks = typeof message.content === 'string' ? JSON.parse(message.content) : message.content
  } catch (e) {
    console.error('[handlePermissionResponse] Failed to parse message content:', e)
    throw new Error('Invalid message content format')
  }

  // Find the pending tool call block
  const block = blocks.find((b) => b.type === 'tool_call' && b.tool_call?.id === toolCallId)
  if (!block) {
    console.warn('[handlePermissionResponse] Tool call block not found:', toolCallId)
    return
  }

  if (granted) {
    // User granted permission
    console.log('[handlePermissionResponse] Permission granted, resuming execution')

    // Add to whitelist if remember is true
    if (remember) {
      try {
        const params =
          typeof block.tool_call?.params === 'string'
            ? JSON.parse(block.tool_call.params)
            : block.tool_call?.params
        const pathPattern = params?.path as string
        if (pathPattern) {
          await presenter.newAgentPresenter.addToWhitelist(
            sessionId,
            block.tool_call?.name || 'unknown',
            pathPattern
          )
          console.log('[handlePermissionResponse] Added to whitelist:', {
            toolName: block.tool_call?.name,
            pathPattern
          })
        }
      } catch (e) {
        console.warn('[handlePermissionResponse] Failed to parse tool params for whitelist:', e)
      }
    }

    // Update tool call block status
    block.status = 'success'
    if (!block.extra) {
      block.extra = {}
    }
    block.extra.needsUserAction = false
    delete block.extra.permissionRequest

    // Update the message in the store
    await messageStore.updateAssistantContent(messageId, blocks)

    // Notify renderer
    eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
      conversationId: sessionId,
      blocks: JSON.parse(JSON.stringify(blocks))
    })

    // Now execute the tool call
    console.log('[handlePermissionResponse] Executing tool call:', block.tool_call?.name)

    try {
      const toolPresenter = agent.toolPresenter
      if (!toolPresenter) {
        throw new Error('Tool presenter not available')
      }

      if (!block.tool_call) {
        throw new Error('Tool call not found in block')
      }

      const toolCall = {
        id: toolCallId,
        type: 'function' as const,
        function: {
          name: block.tool_call.name || '',
          arguments: block.tool_call.params || '{}'
        },
        server: undefined
      }

      const { rawData } = await toolPresenter.callTool(toolCall)
      const responseText =
        typeof rawData.content === 'string' ? rawData.content : JSON.stringify(rawData.content)

      // Update the block with the response
      if (block.tool_call) {
        block.tool_call.response = responseText
      }

      // Update the message in the store
      await messageStore.updateAssistantContent(messageId, blocks)

      // Notify renderer
      eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
        conversationId: sessionId,
        blocks: JSON.parse(JSON.stringify(blocks))
      })

      // Finalize the message
      await messageStore.finalizeAssistantMessage(messageId, blocks, JSON.stringify({}))

      // Notify stream end
      eventBus.sendToRenderer(STREAM_EVENTS.END, SendTarget.ALL_WINDOWS, {
        conversationId: sessionId
      })

      console.log('[handlePermissionResponse] Tool execution completed successfully')
    } catch (error) {
      console.error('[handlePermissionResponse] Tool execution failed:', error)

      // Update block with error
      block.status = 'error'
      if (block.tool_call) {
        block.tool_call.response = `Error: ${error instanceof Error ? error.message : String(error)}`
      }

      await messageStore.updateAssistantContent(messageId, blocks)

      eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
        conversationId: sessionId,
        blocks: JSON.parse(JSON.stringify(blocks))
      })

      // Finalize with error
      await messageStore.setMessageError(messageId, blocks)
    }
  } else {
    // User denied permission
    console.log('[handlePermissionResponse] Permission denied')

    // Update tool call block status
    block.status = 'error'
    if (!block.extra) {
      block.extra = {}
    }
    block.extra.needsUserAction = false
    if (block.tool_call) {
      block.tool_call.response = 'Permission denied by user'
    }

    // Update the message in the store
    await messageStore.updateAssistantContent(messageId, blocks)

    // Finalize the message
    await messageStore.setMessageError(messageId, blocks)

    // Notify renderer
    eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
      conversationId: sessionId,
      blocks: JSON.parse(JSON.stringify(blocks))
    })
  }
}
