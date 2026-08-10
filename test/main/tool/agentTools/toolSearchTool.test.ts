import { describe, expect, it } from 'vitest'
import {
  TOOL_SEARCH_DEFAULT_RESULT_LIMIT,
  TOOL_SEARCH_MAX_QUERY_LENGTH,
  TOOL_SEARCH_MAX_RESULT_LIMIT,
  TOOL_SEARCH_TOOL_SERVER_NAME,
  buildToolSearchDefinition,
  parseToolSearchInput
} from '@/tool/agentTools/toolSearchTool'
import { TOOL_SEARCH_AGENT_TOOL_NAME, getAgentToolExposure } from '@shared/agentTools'
import { TOOL_EXECUTION } from '@shared/types/mcp'

describe('ToolSearch Agent capability', () => {
  it('defines one system-model parallel read tool with the stable reserved identity', () => {
    const definition = buildToolSearchDefinition()

    expect(definition).toMatchObject({
      source: 'agent',
      execution: TOOL_EXECUTION.read.parallel,
      type: 'function',
      function: {
        name: TOOL_SEARCH_AGENT_TOOL_NAME,
        parameters: {
          type: 'object',
          required: ['query']
        }
      },
      server: { name: TOOL_SEARCH_TOOL_SERVER_NAME }
    })
    expect(getAgentToolExposure(definition.function.name)).toBe('system-model')
    expect(definition.function.description).toContain('next model step')
    expect(definition.function.description).toContain('does not execute')
  })

  it('normalizes a bounded query and applies the default result limit', () => {
    expect(parseToolSearchInput({ query: '  search project files  ' })).toEqual({
      success: true,
      data: {
        query: 'search project files',
        limit: TOOL_SEARCH_DEFAULT_RESULT_LIMIT
      }
    })
    expect(parseToolSearchInput({ query: 'browser automation', limit: 1 })).toEqual({
      success: true,
      data: { query: 'browser automation', limit: 1 }
    })
  })

  it('rejects empty, oversized, excessive-limit, and unknown-field inputs', () => {
    for (const input of [
      { query: '   ' },
      { query: 'x'.repeat(TOOL_SEARCH_MAX_QUERY_LENGTH + 1) },
      { query: 'files', limit: TOOL_SEARCH_MAX_RESULT_LIMIT + 1 },
      { query: 'files', unexpected: true }
    ]) {
      const result = parseToolSearchInput(input)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain(`Invalid arguments for ${TOOL_SEARCH_AGENT_TOOL_NAME}.`)
        expect(result.error).not.toContain(String(input.query))
      }
    }
  })
})
