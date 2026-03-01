import type { AssistantMessageBlock } from '@shared/types/agent-interface'
import type { ChatMessage } from '@shared/types/core/chat-message'
import type { MCPToolDefinition } from '@shared/presenter'
import type { IToolPresenter } from '@shared/types/presenters/tool.presenter'
import type { MCPToolCall, MCPContentItem } from '@shared/types/core/mcp'
import type { StreamState, IoParams } from './types'
import { eventBus, SendTarget } from '@/eventbus'
import { STREAM_EVENTS } from '@/events'
import type { PermissionChecker } from './permissionChecker'

// ---- Private helpers ----

function extractTextFromBlocks(blocks: AssistantMessageBlock[]): string {
  return blocks
    .filter((b) => b.type === 'content')
    .map((b) => b.content)
    .join('')
}

function extractReasoningFromBlocks(blocks: AssistantMessageBlock[]): string {
  return blocks
    .filter((b) => b.type === 'reasoning_content')
    .map((b) => b.content)
    .join('')
}

function requiresReasoningField(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return (
    lower.includes('deepseek-reasoner') ||
    lower.includes('kimi-k2-thinking') ||
    lower.includes('glm-4.7')
  )
}

function toolResponseToText(content: string | MCPContentItem[]): string {
  if (typeof content === 'string') return content
  return content
    .map((item) => {
      if (item.type === 'text') return item.text
      if (item.type === 'resource' && item.resource?.text) return item.resource.text
      return `[${item.type}]`
    })
    .join('\n')
}

function updateToolCallBlock(
  blocks: AssistantMessageBlock[],
  toolCallId: string,
  response: string,
  isError: boolean
): void {
  const block = blocks.find((b) => b.type === 'tool_call' && b.tool_call?.id === toolCallId)
  if (block?.tool_call) {
    block.tool_call.response = response
    block.status = isError ? 'error' : 'success'
  }
}

// ---- Public API ----

/**
 * Check permissions for all tool calls in a batch
 * Returns a map of toolCallId -> needsPermission
 */
export async function checkToolPermissions(
  state: StreamState,
  permissionChecker: PermissionChecker | null
): Promise<Map<string, boolean>> {
  const needsPermissionMap = new Map<string, boolean>()

  if (!permissionChecker) {
    // No permission checker = auto-approve all
    for (const tc of state.completedToolCalls) {
      needsPermissionMap.set(tc.id, false)
    }
    return needsPermissionMap
  }

  // Check each tool call
  for (const tc of state.completedToolCalls) {
    const args = safeParseArgs(tc.arguments) as Record<string, string | string[]> | null
    const needsPerm = await permissionChecker.needsPermission(tc.name, {
      path: args?.path as string | undefined,
      paths: args?.paths as string[] | undefined,
      command: args?.command as string | undefined,
      commandSignature: args?.command ? extractCommandSignature(args.command as string) : undefined
    })
    needsPermissionMap.set(tc.id, needsPerm)
  }

  return needsPermissionMap
}

/**
 * Execute completed tool calls with permission checking
 * This is the main entry point that handles permission gating
 */
export async function executeToolsWithPermission(
  state: StreamState,
  conversation: ChatMessage[],
  prevBlockCount: number,
  tools: MCPToolDefinition[],
  toolPresenter: IToolPresenter,
  modelId: string,
  io: IoParams,
  permissionChecker: PermissionChecker | null
): Promise<{ executed: number; shouldContinue: boolean }> {
  // First check which tools need permission
  const needsPermissionMap = await checkToolPermissions(state, permissionChecker)

  // Check if any tool needs permission
  const needsAnyPermission = Array.from(needsPermissionMap.values()).some((v) => v)

  if (needsAnyPermission && permissionChecker) {
    // Create permission batch
    const batch = permissionChecker.createBatch(
      io.sessionId,
      io.messageId,
      state.completedToolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments
      }))
    )

    // Request permissions and wait for all to be resolved
    const permissionResults = await permissionChecker.requestPermissions(batch)

    // Check if we should continue (at least one tool was approved)
    const hasAnyApproved = Array.from(permissionResults.values()).some((v) => v)

    if (!hasAnyApproved) {
      // All denied - return error results for all tools
      return { executed: 0, shouldContinue: false }
    }

    // Execute tools with permission results
    return executeToolsWithResults(
      state,
      conversation,
      prevBlockCount,
      tools,
      toolPresenter,
      modelId,
      io,
      permissionResults
    )
  }

  // No permission needed - execute all tools
  const allApproved = new Map<string, boolean>()
  for (const tc of state.completedToolCalls) {
    allApproved.set(tc.id, true)
  }

  return executeToolsWithResults(
    state,
    conversation,
    prevBlockCount,
    tools,
    toolPresenter,
    modelId,
    io,
    allApproved
  )
}

/**
 * Execute tools with specific permission results
 */
async function executeToolsWithResults(
  state: StreamState,
  conversation: ChatMessage[],
  prevBlockCount: number,
  tools: MCPToolDefinition[],
  toolPresenter: IToolPresenter,
  modelId: string,
  io: IoParams,
  permissionResults: Map<string, boolean>
): Promise<{ executed: number; shouldContinue: boolean }> {
  // Enrich tool_call blocks with server info from tool definitions
  for (const tc of state.completedToolCalls) {
    const toolDef = tools.find((t) => t.function.name === tc.name)
    if (toolDef) {
      const block = state.blocks.find((b) => b.type === 'tool_call' && b.tool_call?.id === tc.id)
      if (block?.tool_call) {
        block.tool_call.server_name = toolDef.server.name
        block.tool_call.server_icons = toolDef.server.icons
        block.tool_call.server_description = toolDef.server.description
      }
    }
  }

  // Build assistant message from this iteration's blocks
  const iterationBlocks = state.blocks.slice(prevBlockCount)
  const assistantText = extractTextFromBlocks(iterationBlocks)
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: assistantText,
    tool_calls: state.completedToolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments }
    }))
  }

  // Interleaved thinking for reasoning models
  if (requiresReasoningField(modelId)) {
    const reasoning = extractReasoningFromBlocks(iterationBlocks)
    if (reasoning) {
      assistantMessage.reasoning_content = reasoning
    }
  }

  conversation.push(assistantMessage)

  let executed = 0

  // Execute each tool call based on permission results
  for (const tc of state.completedToolCalls) {
    if (io.abortSignal.aborted) break

    const isApproved = permissionResults.get(tc.id) ?? false

    if (!isApproved) {
      // Tool was denied - add error result to conversation
      const deniedMessage = 'Error: Permission denied by user'
      conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: deniedMessage
      })
      updateToolCallBlock(state.blocks, tc.id, deniedMessage, true)
      executed++

      // Flush to renderer
      eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
        conversationId: io.sessionId,
        blocks: JSON.parse(JSON.stringify(state.blocks))
      })

      // Persist intermediate state
      io.messageStore.updateAssistantContent(io.messageId, state.blocks)
      continue
    }

    const toolDef = tools.find((t) => t.function.name === tc.name)
    const toolCall: MCPToolCall = {
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
      server: toolDef?.server
    }

    try {
      const { rawData } = await toolPresenter.callTool(toolCall)
      const responseText = toolResponseToText(rawData.content)

      conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: responseText
      })

      updateToolCallBlock(state.blocks, tc.id, responseText, false)
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)

      conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: `Error: ${errorText}`
      })

      updateToolCallBlock(state.blocks, tc.id, `Error: ${errorText}`, true)
    }

    executed++

    // Flush updated blocks to renderer after each tool execution
    eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
      conversationId: io.sessionId,
      blocks: JSON.parse(JSON.stringify(state.blocks))
    })

    // Persist intermediate state to DB
    io.messageStore.updateAssistantContent(io.messageId, state.blocks)
  }

  // Sync persist before continuing to ensure tool results are visible
  // This is critical to prevent the model from re-calling the same tool
  io.messageStore.syncPersist(io.messageId, state.blocks)

  return { executed, shouldContinue: true }
}

/**
 * Execute completed tool calls: build the assistant message, call each tool,
 * update blocks, and flush to renderer + DB after each execution.
 * Returns the number of tool calls executed.
 * @deprecated Use executeToolsWithPermission instead
 */
export async function executeTools(
  state: StreamState,
  conversation: ChatMessage[],
  prevBlockCount: number,
  tools: MCPToolDefinition[],
  toolPresenter: IToolPresenter,
  modelId: string,
  io: IoParams
): Promise<number> {
  // Enrich tool_call blocks with server info from tool definitions
  for (const tc of state.completedToolCalls) {
    const toolDef = tools.find((t) => t.function.name === tc.name)
    if (toolDef) {
      const block = state.blocks.find((b) => b.type === 'tool_call' && b.tool_call?.id === tc.id)
      if (block?.tool_call) {
        block.tool_call.server_name = toolDef.server.name
        block.tool_call.server_icons = toolDef.server.icons
        block.tool_call.server_description = toolDef.server.description
      }
    }
  }

  // Build assistant message from this iteration's blocks
  const iterationBlocks = state.blocks.slice(prevBlockCount)
  const assistantText = extractTextFromBlocks(iterationBlocks)
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: assistantText,
    tool_calls: state.completedToolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments }
    }))
  }

  // Interleaved thinking for reasoning models
  if (requiresReasoningField(modelId)) {
    const reasoning = extractReasoningFromBlocks(iterationBlocks)
    if (reasoning) {
      assistantMessage.reasoning_content = reasoning
    }
  }

  conversation.push(assistantMessage)

  let executed = 0

  // Execute each tool call
  for (const tc of state.completedToolCalls) {
    if (io.abortSignal.aborted) break

    const toolDef = tools.find((t) => t.function.name === tc.name)
    const toolCall: MCPToolCall = {
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
      server: toolDef?.server
    }

    try {
      const { rawData } = await toolPresenter.callTool(toolCall)
      const responseText = toolResponseToText(rawData.content)

      conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: responseText
      })

      updateToolCallBlock(state.blocks, tc.id, responseText, false)
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)

      conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: `Error: ${errorText}`
      })

      updateToolCallBlock(state.blocks, tc.id, `Error: ${errorText}`, true)
    }

    executed++

    // Flush updated blocks to renderer after each tool execution
    eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
      conversationId: io.sessionId,
      blocks: JSON.parse(JSON.stringify(state.blocks))
    })

    // Persist intermediate state to DB
    io.messageStore.updateAssistantContent(io.messageId, state.blocks)
  }

  return executed
}

/**
 * Finalize a successful stream: mark blocks as success, compute metadata, persist.
 */
export function finalize(state: StreamState, io: IoParams): void {
  for (const block of state.blocks) {
    if (block.status === 'pending') block.status = 'success'
  }

  const endTime = Date.now()
  state.metadata.generationTime = endTime - state.startTime
  if (state.firstTokenTime !== null) {
    state.metadata.firstTokenTime = state.firstTokenTime - state.startTime
  }
  if (state.metadata.outputTokens && state.metadata.generationTime > 0) {
    state.metadata.tokensPerSecond = Math.round(
      (state.metadata.outputTokens / state.metadata.generationTime) * 1000
    )
  }

  io.messageStore.finalizeAssistantMessage(
    io.messageId,
    state.blocks,
    JSON.stringify(state.metadata)
  )
  eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
    conversationId: io.sessionId,
    blocks: JSON.parse(JSON.stringify(state.blocks))
  })
  eventBus.sendToRenderer(STREAM_EVENTS.END, SendTarget.ALL_WINDOWS, {
    conversationId: io.sessionId
  })
}

/**
 * Finalize after an error: push error block, mark blocks as error, persist.
 */
export function finalizeError(state: StreamState, io: IoParams, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorBlock: AssistantMessageBlock = {
    type: 'error',
    content: errorMessage,
    status: 'error',
    timestamp: Date.now()
  }
  state.blocks.push(errorBlock)

  for (const block of state.blocks) {
    if (block.status === 'pending') block.status = 'error'
  }

  io.messageStore.setMessageError(io.messageId, state.blocks)
  eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, {
    conversationId: io.sessionId,
    blocks: JSON.parse(JSON.stringify(state.blocks))
  })
  eventBus.sendToRenderer(STREAM_EVENTS.ERROR, SendTarget.ALL_WINDOWS, {
    conversationId: io.sessionId,
    error: errorMessage
  })
}

// ---- Helper functions ----

function safeParseArgs(args: string): Record<string, unknown> | null {
  try {
    return JSON.parse(args)
  } catch {
    return null
  }
}

function extractCommandSignature(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''

  let index = 0
  while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1
  }

  const trimmedTokens = tokens.slice(index)
  if (trimmedTokens.length === 0) return ''

  const signatureTokens = [trimmedTokens[0]]
  if (trimmedTokens.length >= 2) {
    signatureTokens.push(trimmedTokens[1])
  }
  if (trimmedTokens.length >= 3 && trimmedTokens[1]?.startsWith('-')) {
    signatureTokens.push(trimmedTokens[2])
  }
  return signatureTokens.join(' ')
}
