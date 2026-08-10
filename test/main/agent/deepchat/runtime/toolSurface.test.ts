import { describe, expect, it } from 'vitest'
import { TAPE_TOOL_NAMES } from '@shared/agentTools'
import {
  TOOL_EXECUTION,
  type MCPToolDefinition,
  type MCPToolDefinitionBase
} from '@shared/types/core/mcp'
import {
  MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES,
  MAX_TOOL_SURFACE_CANDIDATE_BATCHES,
  MAX_TOOL_SURFACE_DEFINITION_BYTES,
  MAX_TOOL_SURFACE_DEFINITION_DEPTH,
  MAX_TOOL_SURFACE_OVERLAP_IDENTITIES,
  MAX_TOOL_SURFACE_SELECTION_HINTS,
  MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES,
  ToolSurfaceError,
  appendToolSurfaceActivationBatch,
  buildCanonicalToolCatalog,
  buildToolSurfaceRunCeiling,
  computeToolSurfaceShadowDecision,
  computeToolSurfaceStaticDefinitionOverlap,
  createProviderOrderedToolSurfaceActivationLedger,
  createToolSurfaceActivationLedger,
  createToolSurfaceSnapshot,
  mergeToolSurfaceActivationCandidates,
  projectToolSurfaceActiveEntries,
  type ToolSurfaceActivationCandidate,
  type ToolSurfaceDefinitionIdentity,
  type ToolSurfaceShadowPolicy
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

const SHADOW_POLICY: ToolSurfaceShadowPolicy = {
  policyVersion: 'shadow-test-v1',
  enterToolCount: 4,
  exitToolCount: 2,
  enterEstimatedInputTokens: 10_000,
  exitEstimatedInputTokens: 8_000,
  maxInitialToolCount: 4,
  maxInitialDefinitionTokens: 10_000,
  activationReserveToolCount: 1,
  activationReserveDefinitionTokens: 100,
  toolSearchDefinitionTokens: 50,
  toolSearchPromptTokens: 25
}

const candidateScope = {
  sessionId: 'session-1',
  messageId: 'message-1',
  runId: '11111111-1111-4111-8111-111111111111'
}

function definitionIdentity(
  stableTargetKey: string,
  canonicalToolDefinitionHash = 'a'.repeat(64)
): ToolSurfaceDefinitionIdentity {
  return { stableTargetKey, canonicalToolDefinitionHash }
}

function activationCandidate(
  stableTargetKey: string,
  overrides: Partial<ToolSurfaceActivationCandidate> = {}
): ToolSurfaceActivationCandidate {
  return {
    ...candidateScope,
    requestSeq: 1,
    toolCallOrdinalWithinBatch: 0,
    resultRank: 0,
    ...definitionIdentity(stableTargetKey),
    ...overrides
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

describe('Tool Surface provider ordering', () => {
  it('preserves initial order and appends each activation batch deterministically', () => {
    const initial = createToolSurfaceActivationLedger([
      definitionIdentity('target-b'),
      definitionIdentity('target-a')
    ])
    const appended = appendToolSurfaceActivationBatch(initial, [
      definitionIdentity('target-d'),
      definitionIdentity('target-b'),
      definitionIdentity('target-c')
    ])

    expect(appended.entries).toEqual([
      { ...definitionIdentity('target-b'), activationOrdinal: 0 },
      { ...definitionIdentity('target-a'), activationOrdinal: 1 },
      { ...definitionIdentity('target-c'), activationOrdinal: 2 },
      { ...definitionIdentity('target-d'), activationOrdinal: 3 }
    ])
    expect(initial.entries).toHaveLength(2)
    expect(Object.isFrozen(appended)).toBe(true)
    expect(Object.isFrozen(appended.entries)).toBe(true)
    expect(appended.entries.every((entry) => Object.isFrozen(entry))).toBe(true)
    expectSurfaceError(
      () =>
        createToolSurfaceActivationLedger([
          definitionIdentity('target-a'),
          definitionIdentity('target-a')
        ]),
      'conflicting_tool'
    )
  })

  it('filters revoked targets and restores their original ordinals on re-enablement', () => {
    const ledger = appendToolSurfaceActivationBatch(
      createToolSurfaceActivationLedger([
        definitionIdentity('target-b'),
        definitionIdentity('target-a')
      ]),
      [definitionIdentity('target-d'), definitionIdentity('target-c')]
    )

    expect(
      projectToolSurfaceActiveEntries(ledger, [
        definitionIdentity('target-d'),
        definitionIdentity('target-a')
      ]).map((entry) => [entry.stableTargetKey, entry.activationOrdinal])
    ).toEqual([
      ['target-a', 1],
      ['target-d', 3]
    ])
    expect(
      projectToolSurfaceActiveEntries(ledger, [
        definitionIdentity('target-c'),
        definitionIdentity('target-b'),
        definitionIdentity('target-d'),
        definitionIdentity('target-a')
      ]).map((entry) => [entry.stableTargetKey, entry.activationOrdinal])
    ).toEqual([
      ['target-b', 0],
      ['target-a', 1],
      ['target-c', 2],
      ['target-d', 3]
    ])
  })

  it('retains revoked ledger entries while appending and later restoring authority', () => {
    const initial = createToolSurfaceActivationLedger([
      definitionIdentity('target-a'),
      definitionIdentity('target-b'),
      definitionIdentity('target-c')
    ])
    expect(
      projectToolSurfaceActiveEntries(initial, [
        definitionIdentity('target-a'),
        definitionIdentity('target-b')
      ]).map((entry) => entry.stableTargetKey)
    ).toEqual(['target-a', 'target-b'])

    const appended = appendToolSurfaceActivationBatch(initial, [definitionIdentity('target-d')])
    expect(
      projectToolSurfaceActiveEntries(appended, [
        definitionIdentity('target-a'),
        definitionIdentity('target-b'),
        definitionIdentity('target-d')
      ]).map((entry) => [entry.stableTargetKey, entry.activationOrdinal])
    ).toEqual([
      ['target-a', 0],
      ['target-b', 1],
      ['target-d', 3]
    ])
    expect(
      projectToolSurfaceActiveEntries(appended, [
        definitionIdentity('target-d'),
        definitionIdentity('target-c'),
        definitionIdentity('target-b'),
        definitionIdentity('target-a')
      ]).map((entry) => [entry.stableTargetKey, entry.activationOrdinal])
    ).toEqual([
      ['target-a', 0],
      ['target-b', 1],
      ['target-c', 2],
      ['target-d', 3]
    ])
  })

  it('rejects definition drift and malformed activation ledgers', () => {
    const ledger = createToolSurfaceActivationLedger([definitionIdentity('target-a')])
    expectSurfaceError(
      () =>
        appendToolSurfaceActivationBatch(ledger, [
          definitionIdentity('target-a', 'b'.repeat(64))
        ]),
      'conflicting_tool'
    )
    expectSurfaceError(
      () =>
        projectToolSurfaceActiveEntries(ledger, [
          definitionIdentity('target-a', 'b'.repeat(64))
        ]),
      'conflicting_tool'
    )
    expectSurfaceError(
      () =>
        appendToolSurfaceActivationBatch(
          {
            orderingVersion: 'activation-ordinal-v1',
            entries: [{ ...definitionIdentity('target-a'), activationOrdinal: 1 }]
          },
          []
        ),
      'invalid_definition'
    )
    expectSurfaceError(
      () => createToolSurfaceActivationLedger([definitionIdentity('target-a', 'not-a-hash')]),
      'invalid_definition'
    )
  })
})

describe('Run Tool Ceiling and Tool Surface snapshots', () => {
  it('detaches and deeply freezes the bounded Run ceiling', () => {
    const original = agentTool('read', {
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    })

    const ceiling = buildToolSurfaceRunCeiling([original])
    const frozenDefinition = ceiling.entries[0].definition
    original.function.description = 'mutated after freeze'
    ;(original.function.parameters.properties.path as { type: string }).type = 'number'

    expect(frozenDefinition.function.description).toBe('Read a file')
    expect(frozenDefinition.function.parameters.properties.path).toEqual({ type: 'string' })
    expect(Object.isFrozen(ceiling)).toBe(true)
    expect(Object.isFrozen(ceiling.entries)).toBe(true)
    expect(Object.isFrozen(frozenDefinition)).toBe(true)
    expect(Object.isFrozen(frozenDefinition.function)).toBe(true)
    expect(Object.isFrozen(frozenDefinition.function.parameters.properties.path)).toBe(true)
  })

  it('preserves provider order while projecting current revocation into an immutable View', () => {
    const write = agentTool('write')
    const read = agentTool('read')
    const search = agentTool('search')
    const ceiling = buildToolSurfaceRunCeiling([read, search, write])
    const ledger = createProviderOrderedToolSurfaceActivationLedger([write, read, search])

    const revoked = createToolSurfaceSnapshot({
      request: { sessionId: 's1', messageId: 'm1', runId: 'r1', requestSeq: 1 },
      policyVersion: 'full-v1',
      virtualizationTriggered: false,
      ceiling,
      eligibleDefinitions: [read, write],
      activationLedger: ledger
    })
    const restored = createToolSurfaceSnapshot({
      request: { sessionId: 's1', messageId: 'm1', runId: 'r1', requestSeq: 2 },
      policyVersion: 'full-v1',
      virtualizationTriggered: false,
      ceiling,
      eligibleDefinitions: [search, write, read],
      activationLedger: ledger
    })

    expect(revoked.toolDefinitions.map((definition) => definition.function.name)).toEqual([
      'write',
      'read'
    ])
    expect(revoked.activeEntries.map((entry) => entry.activationOrdinal)).toEqual([0, 1])
    expect(restored.toolDefinitions.map((definition) => definition.function.name)).toEqual([
      'write',
      'read',
      'search'
    ])
    expect(restored.activeEntries.map((entry) => entry.activationOrdinal)).toEqual([0, 1, 2])
    expect(Object.isFrozen(restored)).toBe(true)
    expect(Object.isFrozen(restored.request)).toBe(true)
    expect(Object.isFrozen(restored.activeEntries)).toBe(true)
    expect(Object.isFrozen(restored.toolDefinitions)).toBe(true)
    expect(Object.isFrozen(restored.toolDefinitions[0].function.parameters)).toBe(true)
  })

  it('keeps catalog identity canonical while provider activation order follows each input', () => {
    const read = agentTool('read')
    const write = agentTool('write')
    const firstCeiling = buildToolSurfaceRunCeiling([write, read])
    const secondCeiling = buildToolSurfaceRunCeiling([read, write])
    const firstLedger = createProviderOrderedToolSurfaceActivationLedger([write, read, read])
    const secondLedger = createProviderOrderedToolSurfaceActivationLedger([read, write])

    expect(firstCeiling.catalog.fullCatalogHash).toBe(
      buildCanonicalToolCatalog([read, write]).fullCatalogHash
    )
    expect(firstCeiling.catalog.fullCatalogHash).toBe(secondCeiling.catalog.fullCatalogHash)
    expect(firstLedger.entries.map((entry) => entry.stableTargetKey)).toEqual([
      firstCeiling.catalog.entries.find((entry) => entry.target.providerVisibleName === 'write')!
        .stableTargetKey,
      firstCeiling.catalog.entries.find((entry) => entry.target.providerVisibleName === 'read')!
        .stableTargetKey
    ])
    expect(secondLedger.entries.map((entry) => entry.stableTargetKey)).toEqual([
      secondCeiling.catalog.entries.find((entry) => entry.target.providerVisibleName === 'read')!
        .stableTargetKey,
      secondCeiling.catalog.entries.find((entry) => entry.target.providerVisibleName === 'write')!
        .stableTargetKey
    ])
  })

  it('supports a virtualized subset with explicit stable selection reasons', () => {
    const definitions = [agentTool('read'), agentTool('write')]
    const ceiling = buildToolSurfaceRunCeiling(definitions)
    const readEntry = ceiling.catalog.entries.find(
      (entry) => entry.target.providerVisibleName === 'read'
    )!
    const ledger = createToolSurfaceActivationLedger([readEntry])

    const snapshot = createToolSurfaceSnapshot({
      request: { sessionId: 's1', messageId: 'm1', runId: 'r1', requestSeq: 1 },
      policyVersion: 'virtual-v1',
      virtualizationTriggered: true,
      ceiling,
      eligibleDefinitions: definitions,
      activationLedger: ledger,
      selectionReasons: [{ stableTargetKey: readEntry.stableTargetKey, reason: 'core' }]
    })

    expect(snapshot.activeEntries).toHaveLength(1)
    expect(snapshot.activeEntries[0]).toMatchObject({ reason: 'core', activationOrdinal: 0 })
    expect(snapshot.toolDefinitions[0].function.name).toBe('read')
  })

  it('rejects expansion, definition drift, and an incomplete full surface', () => {
    const read = agentTool('read')
    const write = agentTool('write')
    const ceiling = buildToolSurfaceRunCeiling([read])
    const ledger = createProviderOrderedToolSurfaceActivationLedger([read])
    const request = { sessionId: 's1', messageId: 'm1', runId: 'r1', requestSeq: 1 }

    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          request,
          policyVersion: 'full-v1',
          virtualizationTriggered: false,
          ceiling,
          eligibleDefinitions: [read, write],
          activationLedger: ledger
        }),
      'conflicting_tool'
    )
    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          request,
          policyVersion: 'full-v1',
          virtualizationTriggered: false,
          ceiling,
          eligibleDefinitions: [agentTool('read', { function: { ...read.function, description: 'drift' } })],
          activationLedger: ledger
        }),
      'conflicting_tool'
    )
    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          request,
          policyVersion: 'full-v1',
          virtualizationTriggered: false,
          ceiling: buildToolSurfaceRunCeiling([read, write]),
          eligibleDefinitions: [read, write],
          activationLedger: ledger
        }),
      'invalid_definition'
    )
  })

  it('rejects mutable ceilings and selection provenance outside the active View', () => {
    const definitions = [agentTool('read'), agentTool('write')]
    const ceiling = buildToolSurfaceRunCeiling(definitions)
    const readEntry = ceiling.catalog.entries.find(
      (entry) => entry.target.providerVisibleName === 'read'
    )!
    const ledger = createToolSurfaceActivationLedger([readEntry])
    const baseInput = {
      request: { sessionId: 's1', messageId: 'm1', runId: 'r1', requestSeq: 1 },
      policyVersion: 'virtual-v1',
      virtualizationTriggered: true,
      ceiling,
      eligibleDefinitions: definitions,
      activationLedger: ledger
    } as const

    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          ...baseInput,
          ceiling: { catalog: ceiling.catalog, entries: [...ceiling.entries] },
          selectionReasons: [{ stableTargetKey: readEntry.stableTargetKey, reason: 'core' }]
        }),
      'invalid_definition'
    )
    const writeEntry = ceiling.catalog.entries.find(
      (entry) => entry.target.providerVisibleName === 'write'
    )!
    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          ...baseInput,
          selectionReasons: [{ stableTargetKey: writeEntry.stableTargetKey, reason: 'recent' }]
        }),
      'invalid_definition'
    )
    expectSurfaceError(
      () => createToolSurfaceSnapshot({ ...baseInput, selectionReasons: [] }),
      'invalid_definition'
    )
    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          ...baseInput,
          virtualizationTriggered: 'yes' as unknown as boolean,
          selectionReasons: [{ stableTargetKey: readEntry.stableTargetKey, reason: 'core' }]
        }),
      'invalid_definition'
    )
    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          ...baseInput,
          selectionReasons: [
            {
              stableTargetKey: readEntry.stableTargetKey,
              reason: 'unknown' as 'core'
            }
          ]
        }),
      'invalid_definition'
    )
  })

  it('rejects malformed runtime shapes and frozen structural ceiling forgeries', () => {
    const read = agentTool('read')
    const ceiling = buildToolSurfaceRunCeiling([read])
    const ledger = createProviderOrderedToolSurfaceActivationLedger([read])
    const validInput = {
      request: { sessionId: 's1', messageId: 'm1', runId: 'r1', requestSeq: 1 },
      policyVersion: 'full-v1',
      virtualizationTriggered: false,
      ceiling,
      eligibleDefinitions: [read],
      activationLedger: ledger
    }
    const cyclicForgery: Record<string, unknown> = {
      catalog: ceiling.catalog,
      entries: ceiling.entries
    }
    cyclicForgery.self = cyclicForgery
    Object.freeze(cyclicForgery)

    expectSurfaceError(
      () => createToolSurfaceSnapshot(undefined as never),
      'invalid_definition'
    )
    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          ...validInput,
          request: { ...validInput.request, sessionId: 42 as unknown as string }
        }),
      'invalid_definition'
    )
    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          ...validInput,
          selectionReasons: {} as never
        }),
      'invalid_definition'
    )
    expectSurfaceError(
      () =>
        createToolSurfaceSnapshot({
          ...validInput,
          ceiling: cyclicForgery as unknown as typeof ceiling
        }),
      'invalid_definition'
    )
  })
})

describe('Tool Surface activation candidate merge', () => {
  it('orders by request, batch ordinal, result rank, and stable target before deduplication', () => {
    const merged = mergeToolSurfaceActivationCandidates(candidateScope, [
      [
        activationCandidate('target-b', { toolCallOrdinalWithinBatch: 1 }),
        activationCandidate('target-z', { requestSeq: 2 }),
        activationCandidate('target-a', { resultRank: 1 })
      ],
      [
        activationCandidate('target-c'),
        activationCandidate('target-c', {
          requestSeq: 2,
          toolCallOrdinalWithinBatch: 99,
          resultRank: 99
        })
      ]
    ])

    expect(merged.map((candidate) => candidate.stableTargetKey)).toEqual([
      'target-c',
      'target-a',
      'target-b',
      'target-z'
    ])
    expect(merged.find((candidate) => candidate.stableTargetKey === 'target-c')).toMatchObject({
      requestSeq: 1,
      toolCallOrdinalWithinBatch: 0,
      resultRank: 0
    })
    expect(
      mergeToolSurfaceActivationCandidates(candidateScope, [
        [activationCandidate('target-c')],
        [
          activationCandidate('target-b', { toolCallOrdinalWithinBatch: 1 }),
          activationCandidate('target-a', { resultRank: 1 })
        ],
        [activationCandidate('target-z', { requestSeq: 2 })]
      ])
    ).toEqual(merged)
    expect(Object.isFrozen(merged)).toBe(true)
    expect(merged.every((candidate) => Object.isFrozen(candidate))).toBe(true)
  })

  it('uses stable target order rather than opaque operation identity for exact ties', () => {
    const merged = mergeToolSurfaceActivationCandidates(candidateScope, [
      [activationCandidate('target-z'), activationCandidate('target-a')]
    ])

    expect(merged.map((candidate) => candidate.stableTargetKey)).toEqual([
      'target-a',
      'target-z'
    ])
  })

  it('does not retain unbounded search or provider metadata', () => {
    const candidate = {
      ...activationCandidate('target-a'),
      query: 'sensitive raw query',
      toolCallId: 'opaque-provider-id',
      resultBody: { unbounded: true }
    } as ToolSurfaceActivationCandidate

    expect(mergeToolSurfaceActivationCandidates(candidateScope, [[candidate]])).toEqual([
      activationCandidate('target-a')
    ])
  })

  it('rejects mixed scopes, invalid ordinals, and conflicting definition identities', () => {
    expectSurfaceError(
      () =>
        mergeToolSurfaceActivationCandidates(candidateScope, [
          [activationCandidate('target-a', { runId: 'another-run' })]
        ]),
      'invalid_definition'
    )
    expectSurfaceError(
      () =>
        mergeToolSurfaceActivationCandidates(candidateScope, [
          [activationCandidate('target-a', { toolCallOrdinalWithinBatch: -1 })]
        ]),
      'invalid_definition'
    )
    expectSurfaceError(
      () =>
        mergeToolSurfaceActivationCandidates(candidateScope, [
          [
            activationCandidate('target-a'),
            activationCandidate('target-a', { canonicalToolDefinitionHash: 'b'.repeat(64) })
          ]
        ]),
      'conflicting_tool'
    )
  })

  it('bounds candidate batches and aggregate candidate work', () => {
    expect(
      mergeToolSurfaceActivationCandidates(candidateScope, [
        Array.from({ length: MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES }, () =>
          activationCandidate('target-a')
        )
      ])
    ).toHaveLength(1)
    expectSurfaceError(
      () =>
        mergeToolSurfaceActivationCandidates(
          candidateScope,
          Array.from({ length: MAX_TOOL_SURFACE_CANDIDATE_BATCHES + 1 }, () => [])
        ),
      'limit_exceeded'
    )
    expectSurfaceError(
      () =>
        mergeToolSurfaceActivationCandidates(candidateScope, [
          Array.from({ length: MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES + 1 }, (_, index) =>
            activationCandidate(`target-${index}`)
          )
        ]),
      'limit_exceeded'
    )
  })
})

describe('Tool Surface shadow selection', () => {
  it('keeps a small catalog fully active without adding ToolSearch', () => {
    const catalog = buildCanonicalToolCatalog([agentTool('read'), agentTool('write')])

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: SHADOW_POLICY
    })

    expect(decision).toMatchObject({
      virtualizationTriggered: false,
      triggerReason: 'none',
      ceilingToolCount: 2,
      eligibleToolCount: 2,
      hypotheticalActiveToolCount: 2,
      estimatedNetInputTokenReduction: 0,
      toolSearchIncluded: false,
      initialBudgetFits: true,
      degradationCodes: []
    })
    expect(decision.selectedEntries.every((entry) => entry.reason === 'full-catalog')).toBe(true)
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.selectedEntries)).toBe(true)
  })

  it('reports an unavailable mandatory target even when virtualization is not triggered', () => {
    const catalog = buildCanonicalToolCatalog([agentTool('read')])

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: SHADOW_POLICY,
      activeSkillRequiredStableTargetKeys: ['missing-target']
    })

    expect(decision.virtualizationTriggered).toBe(false)
    expect(decision.initialBudgetFits).toBe(false)
    expect(decision.degradationCodes).toEqual(['mandatory-target-missing'])
  })

  it('triggers from the Run ceiling but selects only from current eligibility', () => {
    const definitions = [
      agentTool('alpha'),
      agentTool('beta'),
      agentTool('gamma'),
      agentTool('delta')
    ]
    const ceilingCatalog = buildCanonicalToolCatalog(definitions)
    const eligibleCatalog = buildCanonicalToolCatalog([definitions[0]])

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog,
      eligibleCatalog,
      policy: SHADOW_POLICY,
      coreStableTargetKeys: [eligibleCatalog.entries[0].stableTargetKey]
    })

    expect(decision).toMatchObject({
      virtualizationTriggered: true,
      triggerReason: 'tool-count',
      ceilingToolCount: 4,
      eligibleToolCount: 1,
      hypotheticalActiveToolCount: 2
    })
    expect(decision.selectedEntries.map((entry) => entry.stableTargetKey)).toEqual([
      eligibleCatalog.entries[0].stableTargetKey
    ])
  })

  it('orders policy, core, active Skill, and definition-bound recent selections', () => {
    const catalog = buildCanonicalToolCatalog([
      agentTool('recent'),
      agentTool('skill_required'),
      agentTool('core'),
      agentTool('policy_required')
    ])
    const byName = new Map(
      catalog.entries.map((entry) => [entry.target.providerVisibleName, entry])
    )

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: {
        ...SHADOW_POLICY,
        maxInitialToolCount: 6,
        activationReserveToolCount: 1
      },
      policyRequiredStableTargetKeys: [byName.get('policy_required')!.stableTargetKey],
      coreStableTargetKeys: [byName.get('core')!.stableTargetKey],
      activeSkillRequiredStableTargetKeys: [byName.get('skill_required')!.stableTargetKey],
      recentHints: [
        {
          stableTargetKey: byName.get('recent')!.stableTargetKey,
          canonicalToolDefinitionHash: byName.get('recent')!.canonicalToolDefinitionHash
        }
      ]
    })

    expect(decision).toMatchObject({
      virtualizationTriggered: true,
      triggerReason: 'tool-count',
      hypotheticalActiveToolCount: 5,
      toolSearchIncluded: true,
      initialBudgetFits: true,
      degradationCodes: []
    })
    expect(decision.selectedEntries.map((entry) => entry.reason)).toEqual([
      'policy-required',
      'core',
      'active-skill',
      'recent'
    ])
    expect(decision.eligibleDefinitionTokens - decision.hypotheticalActiveDefinitionTokens).toBe(
      decision.estimatedNetInputTokenReduction + SHADOW_POLICY.toolSearchPromptTokens
    )
  })

  it('accounts for ToolSearch overhead at threshold boundaries', () => {
    const catalog = buildCanonicalToolCatalog([agentTool('read')])
    const policy = {
      ...SHADOW_POLICY,
      enterToolCount: 1,
      exitToolCount: 0,
      enterEstimatedInputTokens: Number.MAX_SAFE_INTEGER,
      exitEstimatedInputTokens: Number.MAX_SAFE_INTEGER - 1
    }

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy
    })

    expect(decision.virtualizationTriggered).toBe(true)
    expect(decision.triggerReason).toBe('tool-count')
  })

  it('holds the virtualized mode inside the cross-Run exit band', () => {
    const catalog = buildCanonicalToolCatalog([agentTool('read'), agentTool('write')])

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: { ...SHADOW_POLICY, enterToolCount: 10, exitToolCount: 2 },
      previouslyVirtualized: true
    })

    expect(decision.virtualizationTriggered).toBe(true)
    expect(decision.triggerReason).toBe('hysteresis')
  })

  it('reports missing or over-budget mandatory targets without silently dropping them', () => {
    const catalog = buildCanonicalToolCatalog([agentTool('skill_required')])
    const mandatoryKey = catalog.entries[0].stableTargetKey

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: {
        ...SHADOW_POLICY,
        enterToolCount: 1,
        exitToolCount: 0,
        maxInitialToolCount: 2,
        activationReserveToolCount: 0,
        activationReserveDefinitionTokens: 0,
        maxInitialDefinitionTokens: SHADOW_POLICY.toolSearchDefinitionTokens
      },
      activeSkillRequiredStableTargetKeys: [mandatoryKey, 'missing-target']
    })

    expect(decision.initialBudgetFits).toBe(false)
    expect(decision.selectedEntries).toEqual([
      expect.objectContaining({ stableTargetKey: mandatoryKey, reason: 'active-skill' })
    ])
    expect(decision.degradationCodes).toEqual([
      'mandatory-budget-exceeded',
      'mandatory-target-missing'
    ])
  })

  it('fails open to a full hypothetical surface when shadow policy is invalid', () => {
    const catalog = buildCanonicalToolCatalog([agentTool('read'), agentTool('write')])

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: { ...SHADOW_POLICY, exitToolCount: SHADOW_POLICY.enterToolCount }
    })

    expect(decision).toMatchObject({
      virtualizationTriggered: false,
      toolSearchIncluded: false,
      initialBudgetFits: false,
      degradationCodes: ['invalid-policy']
    })
    expect(decision.selectedEntries).toHaveLength(2)
  })

  it.each([
    {
      name: 'ToolSearch plus count reserve',
      policy: { ...SHADOW_POLICY, maxInitialToolCount: 1, activationReserveToolCount: 1 }
    },
    {
      name: 'ToolSearch plus token reserve',
      policy: {
        ...SHADOW_POLICY,
        maxInitialDefinitionTokens: 100,
        toolSearchDefinitionTokens: 50,
        activationReserveDefinitionTokens: 51
      }
    },
    {
      name: 'safe-integer overflow',
      policy: {
        ...SHADOW_POLICY,
        maxInitialDefinitionTokens: Number.MAX_SAFE_INTEGER,
        toolSearchDefinitionTokens: Number.MAX_SAFE_INTEGER,
        activationReserveDefinitionTokens: 1
      }
    }
  ])('rejects an impossible $name policy', ({ policy }) => {
    const catalog = buildCanonicalToolCatalog([agentTool('read')])

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy
    })

    expect(decision.degradationCodes).toEqual(['invalid-policy'])
    expect(decision.initialBudgetFits).toBe(false)
  })

  it('does not carry a recent hint across definition drift', () => {
    const priorCatalog = buildCanonicalToolCatalog([agentTool('recent')])
    const currentCatalog = buildCanonicalToolCatalog([
      agentTool('recent', {
        function: {
          name: 'recent',
          description: 'Definition changed',
          parameters: { type: 'object', properties: {} }
        }
      })
    ])
    const prior = priorCatalog.entries[0]

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: currentCatalog,
      eligibleCatalog: currentCatalog,
      policy: { ...SHADOW_POLICY, enterToolCount: 1, exitToolCount: 0 },
      recentHints: [
        {
          stableTargetKey: prior.stableTargetKey,
          canonicalToolDefinitionHash: prior.canonicalToolDefinitionHash
        }
      ]
    })

    expect(decision.selectedEntries).toEqual([])
    expect(decision.hypotheticalActiveToolCount).toBe(1)
  })

  it('preserves newest-first recent hint priority when the initial budget is constrained', () => {
    const catalog = buildCanonicalToolCatalog([
      agentTool('alphabetically_first'),
      agentTool('newest')
    ])
    const byName = new Map(
      catalog.entries.map((entry) => [entry.target.providerVisibleName, entry])
    )

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: {
        ...SHADOW_POLICY,
        enterToolCount: 1,
        exitToolCount: 0,
        maxInitialToolCount: 2,
        activationReserveToolCount: 0,
        maxInitialDefinitionTokens: 10_000,
        activationReserveDefinitionTokens: 0
      },
      recentHints: [
        {
          stableTargetKey: byName.get('newest')!.stableTargetKey,
          canonicalToolDefinitionHash: byName.get('newest')!.canonicalToolDefinitionHash
        },
        {
          stableTargetKey: byName.get('alphabetically_first')!.stableTargetKey,
          canonicalToolDefinitionHash:
            byName.get('alphabetically_first')!.canonicalToolDefinitionHash
        }
      ]
    })

    expect(decision.selectedEntries).toEqual([
      expect.objectContaining({
        stableTargetKey: byName.get('newest')!.stableTargetKey,
        reason: 'recent'
      })
    ])
  })

  it('fails open when current eligibility is not a definition-bound ceiling subset', () => {
    const ceilingCatalog = buildCanonicalToolCatalog([agentTool('read')])
    const eligibleCatalog = buildCanonicalToolCatalog([agentTool('write')])

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog,
      eligibleCatalog,
      policy: SHADOW_POLICY
    })

    expect(decision.degradationCodes).toEqual(['eligible-catalog-invalid'])
    expect(decision.virtualizationTriggered).toBe(false)
    expect(decision.selectedEntries[0].stableTargetKey).toBe(
      eligibleCatalog.entries[0].stableTargetKey
    )
  })

  it('reports a signed estimate when ToolSearch overhead exceeds schema reduction', () => {
    const catalog = buildCanonicalToolCatalog([agentTool('read')])

    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: { ...SHADOW_POLICY, enterToolCount: 1, exitToolCount: 0 }
    })

    expect(decision.estimatedNetInputTokenReduction).toBeLessThan(0)
    expect(decision.hypotheticalAdditionalPromptTokens).toBe(SHADOW_POLICY.toolSearchPromptTokens)
  })

  it('computes bounded overlap from definition-bound identities', () => {
    expect(
      computeToolSurfaceStaticDefinitionOverlap(
        [
          { stableTargetKey: 'a', canonicalToolDefinitionHash: '1' },
          { stableTargetKey: 'a', canonicalToolDefinitionHash: '1' },
          { stableTargetKey: 'b', canonicalToolDefinitionHash: '1' }
        ],
        [
          { stableTargetKey: 'b', canonicalToolDefinitionHash: '2' },
          { stableTargetKey: 'c', canonicalToolDefinitionHash: '1' }
        ]
      )
    ).toEqual({
      previousCount: 2,
      currentCount: 2,
      retainedCount: 0,
      unionCount: 4,
      jaccardRatio: 0
    })
    expect(computeToolSurfaceStaticDefinitionOverlap([], []).jaccardRatio).toBe(1)
  })

  it('bounds selection hints and overlap work', () => {
    const catalog = buildCanonicalToolCatalog([
      agentTool('alpha'),
      agentTool('beta'),
      agentTool('gamma'),
      agentTool('delta')
    ])
    const decision = computeToolSurfaceShadowDecision({
      ceilingCatalog: catalog,
      eligibleCatalog: catalog,
      policy: SHADOW_POLICY,
      coreStableTargetKeys: Array.from(
        { length: MAX_TOOL_SURFACE_SELECTION_HINTS + 1 },
        (_, index) => String(index)
      )
    })

    expect(decision.degradationCodes).toEqual(['selection-input-limit-exceeded'])
    expect(
      computeToolSurfaceShadowDecision({
        ceilingCatalog: catalog,
        eligibleCatalog: catalog,
        policy: SHADOW_POLICY,
        coreStableTargetKeys: ['x'.repeat(MAX_TOOL_SURFACE_DEFINITION_BYTES + 1)]
      }).degradationCodes
    ).toEqual(['selection-input-limit-exceeded'])
    expectSurfaceError(
      () =>
        computeToolSurfaceStaticDefinitionOverlap(
          Array.from({ length: MAX_TOOL_SURFACE_OVERLAP_IDENTITIES + 1 }, (_, index) => ({
            stableTargetKey: String(index),
            canonicalToolDefinitionHash: 'hash'
          })),
          []
        ),
      'limit_exceeded'
    )
  })
})
