import { describe, expect, it } from 'vitest'
import { TAPE_TOOL_NAMES } from '@shared/agentTools'
import {
  TOOL_EXECUTION,
  type MCPToolDefinition,
  type MCPToolDefinitionBase
} from '@shared/types/core/mcp'
import {
  MAX_TOOL_SURFACE_DEFINITION_BYTES,
  MAX_TOOL_SURFACE_DEFINITION_DEPTH,
  MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES,
  ToolSurfaceError,
  buildCanonicalToolCatalog
} from '@/agent/deepchat/runtime/toolSurface'
import { buildProviderVisibleToolDefinitionsHash } from '@/tape/domain/executionContract'

const SERVER_ID = '22222222-2222-4222-8222-222222222222'
const BINDING_HASH = 'a'.repeat(64)

function agentTool(
  name: string,
  overrides: Partial<MCPToolDefinitionBase> = {}
): MCPToolDefinition {
  return {
    source: 'agent',
    execution: TOOL_EXECUTION.read.parallel,
    type: 'function',
    function: {
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} }
    },
    server: {
      name: 'agent-tools',
      icons: '',
      description: 'Agent tools'
    },
    ...overrides
  }
}

function mcpTool(
  visibleName: string,
  overrides: {
    originalName?: string
    serverId?: string
    description?: string
    rawMeta?: Record<string, unknown>
    execution?: MCPToolDefinition['execution']
  } = {}
): MCPToolDefinition {
  return {
    source: 'mcp',
    execution: overrides.execution ?? TOOL_EXECUTION.write,
    type: 'function',
    function: {
      name: visibleName,
      description: overrides.description ?? `${visibleName} description`,
      parameters: { type: 'object', properties: {} }
    },
    server: {
      name: 'remote',
      icons: '',
      description: 'Remote tools',
      id: overrides.serverId ?? SERVER_ID,
      configGeneration: 3,
      bindingHash: BINDING_HASH
    },
    raw: {
      name: overrides.originalName ?? visibleName,
      inputSchema: { type: 'object', properties: {} },
      ...(overrides.rawMeta ? { _meta: overrides.rawMeta } : {})
    }
  }
}

function expectSurfaceError(run: () => unknown, code: ToolSurfaceError['code']): void {
  try {
    run()
    throw new Error('Expected ToolSurfaceError.')
  } catch (error) {
    expect(error).toBeInstanceOf(ToolSurfaceError)
    expect((error as ToolSurfaceError).code).toBe(code)
  }
}

describe('canonical Tool Surface catalog', () => {
  it('has a deterministic full hash and entry order across enumeration order', () => {
    const read = agentTool('read')
    const remote = mcpTool('remote_search', { originalName: 'search' })

    const left = buildCanonicalToolCatalog([remote, read])
    const right = buildCanonicalToolCatalog([read, remote])

    expect(left.fullCatalogHash).toBe(right.fullCatalogHash)
    expect(left.entries.map((entry) => entry.stableTargetKey)).toEqual(
      right.entries.map((entry) => entry.stableTargetKey)
    )
    expect(Object.isFrozen(left)).toBe(true)
    expect(Object.isFrozen(left.entries)).toBe(true)
    expect(Object.isFrozen(left.entries[0].target)).toBe(true)
  })

  it('deduplicates an identical target without double-counting bytes or tokens', () => {
    const definition = mcpTool('remote_search')
    const single = buildCanonicalToolCatalog([definition])
    const duplicate = buildCanonicalToolCatalog([definition, structuredClone(definition)])

    expect(duplicate.entries).toHaveLength(1)
    expect(duplicate.canonicalDefinitionBytes).toBe(single.canonicalDefinitionBytes)
    expect(duplicate.definitionTokens).toBe(single.definitionTokens)
    expect(duplicate.fullCatalogHash).toBe(single.fullCatalogHash)
  })

  it('derives from one detached snapshot without invoking caller accessors', () => {
    const topLevel = agentTool('accessor') as MCPToolDefinition & Record<string, unknown>
    const nested = agentTool('nested_accessor')
    let getterCalls = 0
    Object.defineProperty(topLevel, 'function', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return {
          name: 'accessor',
          description: 'Accessor',
          parameters: { type: 'object', properties: {} }
        }
      }
    })
    const metadata = {} as Record<string, unknown>
    Object.defineProperty(metadata, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 'do-not-read'
      }
    })
    nested.raw = {
      name: 'nested_accessor',
      inputSchema: { type: 'object', properties: {} },
      _meta: metadata
    }

    expectSurfaceError(() => buildCanonicalToolCatalog([topLevel]), 'invalid_definition')
    expectSurfaceError(() => buildCanonicalToolCatalog([nested]), 'invalid_definition')
    expect(getterCalls).toBe(0)
  })

  it('does not mutate or freeze caller definitions and accepts shared acyclic data', () => {
    const shared = { type: 'string' }
    const definition = agentTool('shared_schema', {
      function: {
        name: 'shared_schema',
        description: 'Shared schema',
        parameters: { type: 'object', properties: { left: shared, right: shared } }
      }
    })

    buildCanonicalToolCatalog([definition])

    expect(Object.isFrozen(definition)).toBe(false)
    expect(Object.isFrozen(definition.function)).toBe(false)
    expect(Object.isFrozen(shared)).toBe(false)
  })

  it('hashes canonical definition metadata but excludes the execution policy', () => {
    const base = mcpTool('remote_search')
    const executionChanged = mcpTool('remote_search', {
      execution: TOOL_EXECUTION.read.parallel
    })
    const descriptionChanged = mcpTool('remote_search', { description: 'Changed' })
    const metadataChanged = mcpTool('remote_search', { rawMeta: { revision: 2 } })

    const baseEntry = buildCanonicalToolCatalog([base]).entries[0]
    expect(baseEntry.canonicalToolDefinitionHash).toBe(
      buildProviderVisibleToolDefinitionsHash([base])
    )
    expect(
      buildCanonicalToolCatalog([executionChanged]).entries[0].canonicalToolDefinitionHash
    ).toBe(baseEntry.canonicalToolDefinitionHash)
    expect(
      buildCanonicalToolCatalog([descriptionChanged]).entries[0].canonicalToolDefinitionHash
    ).not.toBe(baseEntry.canonicalToolDefinitionHash)
    expect(
      buildCanonicalToolCatalog([metadataChanged]).entries[0].canonicalToolDefinitionHash
    ).not.toBe(baseEntry.canonicalToolDefinitionHash)
  })

  it('rejects one provider-visible name that resolves to different stable targets', () => {
    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          mcpTool('remote_search'),
          mcpTool('remote_search', {
            serverId: '33333333-3333-4333-8333-333333333333'
          })
        ]),
      'conflicting_tool'
    )
  })

  it('rejects exact target duplicates with conflicting definitions or effects', () => {
    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          mcpTool('remote_search'),
          mcpTool('remote_search', { description: 'Conflicting description' })
        ]),
      'conflicting_tool'
    )
    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          mcpTool('remote_search'),
          mcpTool('remote_search', { execution: TOOL_EXECUTION.read.parallel })
        ]),
      'conflicting_tool'
    )
    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          mcpTool('remote_search', { execution: TOOL_EXECUTION.read.parallel }),
          mcpTool('remote_search', { execution: TOOL_EXECUTION.read.sequential })
        ]),
      'conflicting_tool'
    )
  })

  it('preserves reviewed model exposure and rejects non-model Agent tools', () => {
    expect(buildCanonicalToolCatalog([agentTool(TAPE_TOOL_NAMES.search)]).entries[0].exposure).toBe(
      'system-model'
    )
    expectSurfaceError(
      () => buildCanonicalToolCatalog([agentTool(TAPE_TOOL_NAMES.info)]),
      'ineligible_exposure'
    )
    expectSurfaceError(
      () => buildCanonicalToolCatalog([agentTool(TAPE_TOOL_NAMES.handoff)]),
      'ineligible_exposure'
    )
  })

  it('rejects canonical definitions over the byte limit', () => {
    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          agentTool('oversized', {
            function: {
              name: 'oversized',
              description: 'x'.repeat(MAX_TOOL_SURFACE_DEFINITION_BYTES + 1),
              parameters: { type: 'object', properties: {} }
            }
          })
        ]),
      'limit_exceeded'
    )
  })

  it('accounts for JSON escaping before recursive canonicalization', () => {
    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          agentTool('escaped', {
            function: {
              name: 'escaped',
              description: '\u0000'.repeat(Math.ceil(MAX_TOOL_SURFACE_DEFINITION_BYTES / 6)),
              parameters: { type: 'object', properties: {} }
            }
          })
        ]),
      'limit_exceeded'
    )
  })

  it('bounds aggregate validation work even for duplicate definitions', () => {
    const description = 'x'.repeat(Math.floor(MAX_TOOL_SURFACE_DEFINITION_BYTES / 2))
    const definitions = Array.from(
      { length: Math.ceil(MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES / description.length) + 2 },
      () =>
        agentTool('duplicate_large', {
          function: {
            name: 'duplicate_large',
            description,
            parameters: { type: 'object', properties: {} }
          }
        })
    )

    expectSurfaceError(() => buildCanonicalToolCatalog(definitions), 'limit_exceeded')
  })

  it('rejects adversarial nesting before canonical recursive hashing', () => {
    let nested: Record<string, unknown> = {}
    for (let depth = 0; depth <= MAX_TOOL_SURFACE_DEFINITION_DEPTH; depth += 1) {
      nested = { nested }
    }

    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          agentTool('deep_schema', {
            function: {
              name: 'deep_schema',
              description: 'Deep schema',
              parameters: { type: 'object', properties: nested }
            }
          })
        ]),
      'limit_exceeded'
    )
  })

  it('rejects circular schemas and undefined array elements', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          agentTool('circular', {
            function: {
              name: 'circular',
              description: 'Circular schema',
              parameters: { type: 'object', properties: circular }
            }
          })
        ]),
      'invalid_definition'
    )

    expectSurfaceError(
      () =>
        buildCanonicalToolCatalog([
          mcpTool('undefined_array', { rawMeta: { values: [undefined] } })
        ]),
      'invalid_definition'
    )
  })

  it('rejects Proxy definitions before property traversal', () => {
    let trapCalls = 0
    const definition = new Proxy(agentTool('proxied'), {
      ownKeys: (target) => {
        trapCalls += 1
        return Reflect.ownKeys(target)
      }
    })

    expectSurfaceError(() => buildCanonicalToolCatalog([definition]), 'invalid_definition')
    expect(trapCalls).toBe(0)
  })

  it('normalizes object key order before token estimation', () => {
    const leftProperties = { alpha: { type: 'string' }, beta: { type: 'number' } }
    const rightProperties = { beta: { type: 'number' }, alpha: { type: 'string' } }
    const left = agentTool('ordered', {
      function: {
        name: 'ordered',
        description: 'Ordered',
        parameters: { type: 'object', properties: leftProperties }
      }
    })
    const right = agentTool('ordered', {
      function: {
        name: 'ordered',
        description: 'Ordered',
        parameters: { type: 'object', properties: rightProperties }
      }
    })

    expect(buildCanonicalToolCatalog([left]).definitionTokens).toBe(
      buildCanonicalToolCatalog([right]).definitionTokens
    )
  })
})
