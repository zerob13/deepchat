import { describe, expect, it } from 'vitest'
import { TOOL_EXECUTION, type MCPToolDefinition } from '@shared/types/core/mcp'
import { buildCanonicalToolCatalog } from '@/agent/deepchat/runtime/toolSurface'
import { buildToolSearchDefinition } from '@/tool/agentTools/toolSearchTool'
import { buildExecutionContract } from '@/tape/domain/executionContract'
import {
  TAPE_TOOL_CATALOG_EVENT_NAME,
  TAPE_TOOL_SURFACE_EVENT_NAME,
  buildTapeToolResultPayloadHash,
  type CreateTapeToolSurfaceFactInput,
  type TapeToolCatalogSourceEntry,
  type TapeToolSurfaceActiveEntry
} from '@/tape/domain/toolSurfaceFacts'
import { createTapeViewManifest } from '@/tape/domain/viewManifest'
import {
  ToolSurfaceProvenanceCorruptionError,
  ToolSurfaceProvenanceError
} from '@/tape/application/toolSurfaceProvenanceService'
import {
  DatabaseCtor,
  DeepChatTapeEntriesTable,
  createTapeService,
  createTapeTableMock,
  itIfSqlite
} from './tapeTestHarness'

const SESSION_ID = 'session-1'
const MESSAGE_ID = 'message-1'
const RUN_ID = '11111111-1111-4111-8111-111111111111'

const TOOL: MCPToolDefinition = {
  type: 'function',
  source: 'mcp',
  execution: TOOL_EXECUTION.read.parallel,
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  server: {
    name: 'filesystem',
    id: '22222222-2222-4222-8222-222222222222',
    configGeneration: 1,
    bindingHash: 'a'.repeat(64),
    icons: '',
    description: 'Filesystem tools'
  },
  raw: {
    name: 'read_file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }
}

function toCatalogEntry(
  entry: ReturnType<typeof buildCanonicalToolCatalog>['entries'][number]
): TapeToolCatalogSourceEntry {
  return {
    target: entry.target,
    stableTargetKey: entry.stableTargetKey,
    canonicalToolDefinitionHash: entry.canonicalToolDefinitionHash,
    exposure: entry.exposure,
    execution: entry.execution
  }
}

function createCommitInput(requestSeq = 1, content = 'Read a file') {
  const messages = [{ role: 'user' as const, content }]
  const catalog = buildCanonicalToolCatalog([TOOL])
  const catalogEntries = catalog.entries.map(toCatalogEntry)
  const activeEntries: TapeToolSurfaceActiveEntry[] = catalogEntries.map((entry, index) => ({
    ...entry,
    activationOrdinal: index,
    reason: 'full-catalog'
  }))
  const executionContract = buildExecutionContract({
    request: {
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      runId: RUN_ID,
      requestSeq
    },
    promptAssembly: { prompt: '', sections: [] },
    providerMessages: messages,
    tools: [TOOL],
    providerId: 'openai',
    modelId: 'gpt-5',
    modelConfig: {} as any,
    temperature: 0.2,
    maxTokens: 100,
    workspace: { kind: 'runtime_default' },
    maxSubagentDepth: 0,
    dynamicControlSnapshot: {
      permissionMode: 'default',
      requestAdmitted: true,
      cancellationRequested: false
    },
    assemblerVersion: 'test-v1'
  })
  const manifest = createTapeViewManifest({
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    requestSeq,
    taskType: requestSeq === 1 ? 'chat' : 'tool_loop',
    policy: 'legacy_context_v1',
    policyVersion: 1,
    contextBuilderVersion: 'legacy-v1',
    messages,
    tools: [TOOL],
    latestEntryId: 0,
    anchorEntryIds: [],
    included: [],
    excluded: [],
    tokenBudget: {
      contextLength: 1_000,
      requestedMaxTokens: 100,
      effectiveMaxTokens: 100,
      reserveTokens: 100,
      toolReserveTokens: catalog.definitionTokens
    },
    providerId: 'openai',
    modelId: 'gpt-5',
    summaryCursorOrderSeq: 0,
    supportsVision: false,
    supportsAudioInput: false,
    traceDebugEnabled: false,
    executionContract,
    assembledAt: 200 + requestSeq
  })
  const surface = {
    request: executionContract.request,
    canonicalizationVersion: catalog.canonicalizationVersion,
    orderingVersion: 'activation-ordinal-v1',
    policyVersion: 'full-catalog-v1',
    virtualizationTriggered: false,
    contractBearing: true,
    activeEntries,
    budget: {
      eligibleToolCount: catalog.entries.length,
      activeToolCount: catalog.entries.length,
      eligibleDefinitionTokens: catalog.definitionTokens,
      activeDefinitionTokens: catalog.definitionTokens
    }
  } satisfies Omit<CreateTapeToolSurfaceFactInput, 'manifestHash' | 'catalog'>
  return {
    manifest,
    activeToolDefinitions: [TOOL],
    catalog: {
      catalogSchemaVersion: catalog.schemaVersion,
      canonicalizationVersion: catalog.canonicalizationVersion,
      fullCatalogHash: catalog.fullCatalogHash,
      entries: catalogEntries
    },
    surface
  }
}

function createVirtualizedCommitInput(
  toolResult: {
    entryId: number
    tapeIncarnationId: string
    payloadHash: string
  },
  latestEntryId = toolResult.entryId
) {
  const toolSearch = buildToolSearchDefinition()
  const tools = [toolSearch, TOOL]
  const messages = [{ role: 'user' as const, content: 'Find and read a file' }]
  const catalog = buildCanonicalToolCatalog(tools)
  const catalogEntries = catalog.entries.map(toCatalogEntry)
  const entryByName = new Map(
    catalogEntries.map((entry) => [entry.target.providerVisibleName, entry])
  )
  const toolSearchEntry = entryByName.get('tool_search')!
  const readFileEntry = entryByName.get('read_file')!
  const request = {
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    runId: RUN_ID,
    requestSeq: 2
  }
  const executionContract = buildExecutionContract({
    request,
    promptAssembly: { prompt: '', sections: [] },
    providerMessages: messages,
    tools,
    providerId: 'openai',
    modelId: 'gpt-5',
    modelConfig: {} as any,
    temperature: 0.2,
    maxTokens: 100,
    workspace: { kind: 'runtime_default' },
    maxSubagentDepth: 0,
    dynamicControlSnapshot: {
      permissionMode: 'default',
      requestAdmitted: true,
      cancellationRequested: false
    },
    assemblerVersion: 'test-v1'
  })
  const manifest = createTapeViewManifest({
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    requestSeq: 2,
    taskType: 'tool_loop',
    policy: 'legacy_context_v1',
    policyVersion: 1,
    contextBuilderVersion: 'legacy-v1',
    messages,
    tools,
    latestEntryId,
    anchorEntryIds: [1],
    included: [],
    excluded: [],
    tokenBudget: {
      contextLength: 1_000,
      requestedMaxTokens: 100,
      effectiveMaxTokens: 100,
      reserveTokens: 100,
      toolReserveTokens: catalog.definitionTokens
    },
    providerId: 'openai',
    modelId: 'gpt-5',
    summaryCursorOrderSeq: 0,
    supportsVision: false,
    supportsAudioInput: false,
    traceDebugEnabled: false,
    executionContract,
    assembledAt: 300
  })
  return {
    manifest,
    activeToolDefinitions: tools,
    catalog: {
      catalogSchemaVersion: catalog.schemaVersion,
      canonicalizationVersion: catalog.canonicalizationVersion,
      fullCatalogHash: catalog.fullCatalogHash,
      entries: catalogEntries
    },
    surface: {
      request,
      canonicalizationVersion: catalog.canonicalizationVersion,
      orderingVersion: 'activation-ordinal-v1',
      policyVersion: 'virtualized-v1',
      virtualizationTriggered: true,
      contractBearing: true,
      activeEntries: [
        { ...toolSearchEntry, activationOrdinal: 0, reason: 'tool-search' as const },
        { ...readFileEntry, activationOrdinal: 1, reason: 'search-result' as const }
      ],
      budget: {
        eligibleToolCount: catalog.entries.length,
        activeToolCount: catalog.entries.length,
        eligibleDefinitionTokens: catalog.definitionTokens,
        activeDefinitionTokens: catalog.definitionTokens
      },
      searchResultRefs: [
        {
          originRequestSeq: 1,
          toolCallOrdinalWithinBatch: 0,
          resultRank: 0,
          stableTargetKey: readFileEntry.stableTargetKey,
          canonicalToolDefinitionHash: readFileEntry.canonicalToolDefinitionHash,
          toolResult: {
            sessionId: SESSION_ID,
            tapeIncarnationId: toolResult.tapeIncarnationId,
            entryId: toolResult.entryId,
            payloadHashVersion: 1 as const,
            payloadHash: toolResult.payloadHash
          }
        }
      ]
    }
  }
}

function appendToolSearchResult(table: ReturnType<typeof createTapeTableMock>['table']) {
  table.ensureBootstrapAnchor(SESSION_ID)
  const tapeIncarnationId = JSON.parse(table.getByEntryId(SESSION_ID, 1).meta_json)
    .tapeIncarnationId as string
  const payload = {
    messageId: MESSAGE_ID,
    orderSeq: 1,
    toolCallId: 'search-call-1',
    response: JSON.stringify({
      results: [
        {
          name: 'read_file',
          source: 'MCP',
          description: 'Read a file',
          effect: 'read',
          state: 'pending'
        }
      ]
    })
  }
  const row = table.append({
    sessionId: SESSION_ID,
    kind: 'tool_result',
    name: 'tool_search',
    source: { type: 'tool_result', id: `${MESSAGE_ID}:search-call-1`, seq: 0 },
    payload,
    meta: { status: 'success' },
    createdAt: 250
  })
  return {
    entryId: row.entry_id,
    tapeIncarnationId,
    payloadHash: buildTapeToolResultPayloadHash(payload)
  }
}

describe('ToolSurfaceProvenanceService', () => {
  it('atomically commits one canonical manifest, catalog, and surface', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const input = createCommitInput()

    const receipt = service.commitToolSurfaceView(input)

    expect(entries.map((entry) => entry.name)).toEqual([
      'session/start',
      'view/assembled',
      TAPE_TOOL_CATALOG_EVENT_NAME,
      TAPE_TOOL_SURFACE_EVENT_NAME
    ])
    expect(receipt.manifest).toMatchObject({ entryId: 2, created: true })
    expect(receipt.catalog).toMatchObject({ entryId: 3, created: true })
    expect(receipt.surface).toMatchObject({ entryId: 4, created: true })

    const surfacePayload = JSON.parse(entries[3].payload_json)
    expect(surfacePayload.data.catalog).toMatchObject({
      sessionId: SESSION_ID,
      tapeIncarnationId: receipt.tapeIncarnationId,
      entryId: receipt.catalog.entryId,
      fullCatalogHash: receipt.catalog.fullCatalogHash,
      catalogFactHash: receipt.catalog.catalogFactHash
    })
    expect(surfacePayload.data.manifestHash).toBe(input.manifest.hashes.manifestHash)
  })

  it('reuses exact facts and one catalog fact across later Views in the same incarnation', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const firstInput = createCommitInput(1)

    const first = service.commitToolSurfaceView(firstInput)
    const repeated = service.commitToolSurfaceView(firstInput)
    const later = service.commitToolSurfaceView(createCommitInput(2))

    expect(repeated.manifest.created).toBe(false)
    expect(repeated.catalog.created).toBe(false)
    expect(repeated.surface.created).toBe(false)
    expect(repeated.surface.entryId).toBe(first.surface.entryId)
    expect(later.catalog.created).toBe(false)
    expect(later.catalog.entryId).toBe(first.catalog.entryId)
    expect(entries.filter((entry) => entry.name === TAPE_TOOL_CATALOG_EVENT_NAME)).toHaveLength(1)
    expect(entries.filter((entry) => entry.name === TAPE_TOOL_SURFACE_EVENT_NAME)).toHaveLength(2)
  })

  it('creates new physical facts after a Tape reset changes the incarnation', () => {
    const { table } = createTapeTableMock()
    const service = createTapeService(table)
    const input = createCommitInput()
    const first = service.commitToolSurfaceView(input)

    service.resetSessionTape(SESSION_ID)
    const afterReset = service.commitToolSurfaceView(input)

    expect(afterReset.tapeIncarnationId).not.toBe(first.tapeIncarnationId)
    expect(afterReset.catalog.created).toBe(true)
    expect(afterReset.surface.created).toBe(true)
    expect(afterReset.surface.surfaceHash).not.toBe(first.surface.surfaceHash)
  })

  it('treats the same surface identity with different content as corruption', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const input = createCommitInput()
    service.commitToolSurfaceView(input)

    expect(() =>
      service.commitToolSurfaceView({
        ...input,
        surface: { ...input.surface, policyVersion: 'different-policy-v1' }
      })
    ).toThrow(ToolSurfaceProvenanceCorruptionError)
    expect(entries.filter((entry) => entry.name === TAPE_TOOL_SURFACE_EVENT_NAME)).toHaveLength(1)
  })

  it('rejects a conflicting manifest for an existing request identity', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const input = createCommitInput()
    service.commitToolSurfaceView(input)

    const conflicting = createCommitInput(1, 'Different prompt')

    expect(() => service.commitToolSurfaceView(conflicting)).toThrow(
      ToolSurfaceProvenanceCorruptionError
    )
    expect(entries.filter((entry) => entry.name === 'view/assembled')).toHaveLength(1)
  })

  it('rolls back the manifest and catalog when the surface append fails', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const append = table.appendToolSurfaceEvent.getMockImplementation()!
    table.appendToolSurfaceEvent.mockImplementationOnce(append).mockImplementationOnce(() => {
      throw new Error('surface write failed')
    })

    expect(() => service.commitToolSurfaceView(createCommitInput())).toThrow(
      ToolSurfaceProvenanceError
    )
    expect(entries).toEqual([])
  })

  it('fails closed when the existing Tape has no canonical incarnation', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    table.appendAnchor({
      sessionId: SESSION_ID,
      name: 'session/start',
      source: { type: 'session', id: SESSION_ID, seq: 0 },
      state: { owner: 'human' },
      meta: {}
    })

    expect(() => service.commitToolSurfaceView(createCommitInput())).toThrow(
      ToolSurfaceProvenanceCorruptionError
    )
    expect(entries).toHaveLength(1)
  })

  it('binds ToolSearch activation to an earlier physical result fact', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const result = appendToolSearchResult(table)

    const receipt = service.commitToolSurfaceView(createVirtualizedCommitInput(result))

    expect(receipt.surface.created).toBe(true)
    expect(entries.filter((entry) => entry.name === TAPE_TOOL_SURFACE_EVENT_NAME)).toHaveLength(1)
  })

  it('rejects ToolSearch activation whose physical result hash does not match', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const result = appendToolSearchResult(table)

    expect(() =>
      service.commitToolSurfaceView(
        createVirtualizedCommitInput({ ...result, payloadHash: '0'.repeat(64) })
      )
    ).toThrow(ToolSurfaceProvenanceError)
    expect(entries.map((entry) => entry.name)).toEqual(['session/start', 'tool_search'])
  })

  it('rejects an unsuccessful physical ToolSearch result', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const result = appendToolSearchResult(table)
    table.getByEntryId(SESSION_ID, result.entryId).meta_json = JSON.stringify({ status: 'error' })

    expect(() => service.commitToolSurfaceView(createVirtualizedCommitInput(result))).toThrow(
      ToolSurfaceProvenanceError
    )
    expect(entries.map((entry) => entry.name)).toEqual(['session/start', 'tool_search'])
  })

  it('rejects ToolSearch activation outside the manifest Tape head', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const result = appendToolSearchResult(table)

    expect(() =>
      service.commitToolSurfaceView(createVirtualizedCommitInput(result, result.entryId - 1))
    ).toThrow(ToolSurfaceProvenanceError)
    expect(entries.map((entry) => entry.name)).toEqual(['session/start', 'tool_search'])
  })

  it('rejects a ToolSearch rank that names a different result', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const result = appendToolSearchResult(table)
    const input = createVirtualizedCommitInput(result)
    input.surface.searchResultRefs[0].resultRank = 1

    expect(() => service.commitToolSurfaceView(input)).toThrow(ToolSurfaceProvenanceError)
    expect(entries.map((entry) => entry.name)).toEqual(['session/start', 'tool_search'])
  })

  it('rejects active evidence that disagrees with the strict contract before writing', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const input = createCommitInput()
    const altered = structuredClone(input)
    altered.surface.activeEntries[0].execution = TOOL_EXECUTION.write

    expect(() => service.commitToolSurfaceView(altered)).toThrow(ToolSurfaceProvenanceError)
    expect(entries).toEqual([])
    expect(table.runInTransaction).not.toHaveBeenCalled()
  })

  it('rejects definitions that did not produce the manifest before writing', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const input = createCommitInput()
    const altered = structuredClone(input)
    altered.activeToolDefinitions[0].function.description = 'A different provider-visible schema'

    expect(() => service.commitToolSurfaceView(altered)).toThrow(ToolSurfaceProvenanceError)
    expect(entries).toEqual([])
    expect(table.runInTransaction).not.toHaveBeenCalled()
  })

  it('owns the transaction boundary instead of nesting inside a caller transaction', () => {
    const { table } = createTapeTableMock()
    const service = createTapeService(table)

    expect(() =>
      table.runInTransaction(() => service.commitToolSurfaceView(createCommitInput()))
    ).toThrow(ToolSurfaceProvenanceError)
  })

  it('rejects an exact surface persisted before its manifest or catalog', () => {
    const { table, entries } = createTapeTableMock()
    const service = createTapeService(table)
    const input = createCommitInput()
    service.commitToolSurfaceView(input)
    const surface = entries.find((entry) => entry.name === TAPE_TOOL_SURFACE_EVENT_NAME)!
    surface.entry_id = 2

    expect(() => service.commitToolSurfaceView(input)).toThrow(ToolSurfaceProvenanceCorruptionError)
  })

  itIfSqlite('enforces canonical idempotency with the SQLite persistence adapter', () => {
    const db = new DatabaseCtor(':memory:')
    const table = new DeepChatTapeEntriesTable(db)
    table.createTable()
    const service = createTapeService(table)
    const input = createCommitInput()

    const first = service.commitToolSurfaceView(input)
    const repeated = service.commitToolSurfaceView(input)
    const rows = table.getBySession(SESSION_ID)

    expect(repeated.surface.entryId).toBe(first.surface.entryId)
    expect(rows.filter((row) => row.name === TAPE_TOOL_CATALOG_EVENT_NAME)).toHaveLength(1)
    expect(rows.filter((row) => row.name === TAPE_TOOL_SURFACE_EVENT_NAME)).toHaveLength(1)
    expect(
      table.getEventsBySource(
        SESSION_ID,
        TAPE_TOOL_SURFACE_EVENT_NAME,
        'runtime_event',
        MESSAGE_ID,
        1
      )
    ).toHaveLength(1)

    db.close()
  })

  itIfSqlite('rolls back all View facts when the SQLite surface append fails', () => {
    const db = new DatabaseCtor(':memory:')
    const table = new DeepChatTapeEntriesTable(db)
    table.createTable()
    db.exec(`
      CREATE TRIGGER fail_tool_surface_insert
      BEFORE INSERT ON deepchat_tape_entries
      WHEN NEW.name = '${TAPE_TOOL_SURFACE_EVENT_NAME}'
      BEGIN
        SELECT RAISE(ABORT, 'surface write failed');
      END;
    `)
    const service = createTapeService(table)

    expect(() => service.commitToolSurfaceView(createCommitInput())).toThrow(
      ToolSurfaceProvenanceError
    )
    expect(table.getBySession(SESSION_ID)).toEqual([])

    db.close()
  })
})
