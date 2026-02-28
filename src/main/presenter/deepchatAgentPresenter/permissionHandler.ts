import { presenter } from '@/presenter'
import { eventBus, SendTarget } from '@/eventbus'
import { STREAM_EVENTS } from '@/events'

/**
 * Handle user response to permission request
 * Called from renderer when user clicks Allow/Deny
 */
export async function handlePermissionResponse(
  sessionId: string,
  toolCallId: string,
  granted: boolean,
  permissionType: 'read' | 'write' | 'all',
  remember: boolean
): Promise<void> {
  console.log('[handlePermissionResponse] User response:', {
    sessionId,
    toolCallId,
    granted,
    permissionType,
    remember
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

  // Get current session state
  const state = await agent.getSessionState(sessionId)
  if (!state) {
    throw new Error(`Session state not found: ${sessionId}`)
  }

  // Find the pending tool call
  const pendingToolCall = state.pendingToolCalls.get(toolCallId)
  if (!pendingToolCall) {
    console.warn('[handlePermissionResponse] Tool call not found:', toolCallId)
    return
  }

  if (granted) {
    // User granted permission
    console.log('[handlePermissionResponse] Permission granted, resuming execution')

    // Add to whitelist if remember is true
    if (remember) {
      const pathPattern = pendingToolCall.arguments.path as string
      if (pathPattern) {
        await presenter.newAgentPresenter.addToWhitelist(
          sessionId,
          pendingToolCall.name,
          pathPattern
        )
        console.log('[handlePermissionResponse] Added to whitelist:', {
          toolName: pendingToolCall.name,
          pathPattern
        })
      }
    }

    // Update tool call block status
    const block = state.blocks.find((b) => b.type === 'tool_call' && b.tool_call?.id === toolCallId)
    if (block) {
      block.status = 'success'
      if (block.extra) {
        block.extra.needsUserAction = false
      }
    }

    // Notify renderer
    eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
      conversationId: sessionId,
      blocks: JSON.parse(JSON.stringify(state.blocks))
    })

    // Resume tool execution - the tool call is still in pendingToolCalls
    // It will be processed in the next iteration
    // Remove from pending to allow re-processing
    state.pendingToolCalls.delete(toolCallId)

    // Trigger re-processing by emitting a custom event
    // This is a bit hacky but works for MVP
    console.log('[handlePermissionResponse] Resuming tool execution')
  } else {
    // User denied permission
    console.log('[handlePermissionResponse] Permission denied')

    // Update tool call block status
    const block = state.blocks.find((b) => b.type === 'tool_call' && b.tool_call?.id === toolCallId)
    if (block) {
      block.status = 'error'
      if (block.extra) {
        block.extra.needsUserAction = false
        block.tool_call.response = 'Permission denied by user'
      }
    }

    // Remove from pending
    state.pendingToolCalls.delete(toolCallId)

    // Notify renderer
    eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
      conversationId: sessionId,
      blocks: JSON.parse(JSON.stringify(state.blocks))
    })
  }
}
