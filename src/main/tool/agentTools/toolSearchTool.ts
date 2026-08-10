import { TOOL_SEARCH_AGENT_TOOL_NAME } from '@shared/agentTools'
import { toDeepChatJsonSchema } from '@shared/lib/zodJsonSchema'
import { TOOL_EXECUTION, type MCPToolDefinition } from '@shared/types/mcp'
import { z } from 'zod'

export const TOOL_SEARCH_TOOL_SERVER_NAME = 'agent-tool-surface'
export const TOOL_SEARCH_DEFAULT_RESULT_LIMIT = 5
export const TOOL_SEARCH_MAX_RESULT_LIMIT = 8
export const TOOL_SEARCH_MAX_QUERY_LENGTH = 512

export const toolSearchInputSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .min(1)
    .max(TOOL_SEARCH_MAX_QUERY_LENGTH)
    .describe('Natural-language description of the capability needed for the next step.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(TOOL_SEARCH_MAX_RESULT_LIMIT)
    .optional()
    .default(TOOL_SEARCH_DEFAULT_RESULT_LIMIT)
    .describe('Maximum number of matching capabilities to return.')
})

export type ToolSearchInput = z.infer<typeof toolSearchInputSchema>

export type ToolSearchInputParseResult =
  | { readonly success: true; readonly data: ToolSearchInput }
  | { readonly success: false; readonly error: string }

export function parseToolSearchInput(input: unknown): ToolSearchInputParseResult {
  const parsed = toolSearchInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid arguments for ${TOOL_SEARCH_AGENT_TOOL_NAME}. Provide a non-empty query of at most ${TOOL_SEARCH_MAX_QUERY_LENGTH} characters and an optional integer limit from 1 to ${TOOL_SEARCH_MAX_RESULT_LIMIT}.`
    }
  }
  return { success: true, data: parsed.data }
}

export function buildToolSearchDefinition(): MCPToolDefinition {
  return {
    source: 'agent',
    execution: TOOL_EXECUTION.read.parallel,
    type: 'function',
    function: {
      name: TOOL_SEARCH_AGENT_TOOL_NAME,
      description:
        'Find currently discoverable tools for a capability. Matching tools become candidates for the next model step; this call does not execute them and does not return their full schemas.',
      parameters: toDeepChatJsonSchema(toolSearchInputSchema) as {
        type: string
        properties: Record<string, unknown>
        required?: string[]
      }
    },
    server: {
      name: TOOL_SEARCH_TOOL_SERVER_NAME,
      icons: 'search',
      description: 'Agent tool discovery'
    }
  }
}
