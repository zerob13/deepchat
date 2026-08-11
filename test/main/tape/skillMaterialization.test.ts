import { describe, expect, it } from 'vitest'
import {
  buildTapeSkillMaterializationPayloadHash,
  buildTapeSkillMaterializationRef,
  createTapeSkillMaterializationPayload,
  hashSkillEffectiveContent,
  validateTapeSkillMaterializationBatch,
  validateTapeSkillMaterializationPayload,
  type TapeSkillMaterializationInput
} from '@/tape/domain/skillMaterialization'
import { TapeSkillMaterializationService } from '@/tape/application/skillMaterializationService'
import type { DeepChatTapeEntryRow } from '@/tape/domain/entry'

const hash = hashSkillEffectiveContent('fixture')

function input(content = 'hello 🌍'): TapeSkillMaterializationInput {
  return {
    sessionId: 'session-1',
    expectedTapeIncarnationId: 'incarnation-1',
    agentId: 'agent-1',
    sourceType: 'builtin',
    sourceId: 'source-1',
    skillName: 'skill-1',
    effectiveContent: content,
    builderVersion: 'builder-1',
    renderedManifestHash: hash,
    scriptInventoryHash: hash
  }
}

function createMaterializationStore() {
  const rows: DeepChatTapeEntryRow[] = []
  let tapeIncarnationId = 'incarnation-1'
  let failNextAppend = false
  const store = {
    ensureBootstrapAnchor: () => undefined,
    getBootstrapIncarnation: () => tapeIncarnationId,
    getByEntryId: (sessionId: string, entryId: number) =>
      rows.find((row) => row.session_id === sessionId && row.entry_id === entryId),
    getByProvenanceKey: (sessionId: string, provenanceKey: string) =>
      rows.find((row) => row.session_id === sessionId && row.provenance_key === provenanceKey),
    appendSkillMaterialization: (append: {
      sessionId: string
      sourceId: string
      provenanceKey: string
      payload: ReturnType<typeof createTapeSkillMaterializationPayload>
      payloadHash: string
    }) => {
      if (failNextAppend) {
        failNextAppend = false
        throw new Error('injected append failure')
      }
      const existing = store.getByProvenanceKey(append.sessionId, append.provenanceKey)
      if (existing) return existing
      const row: DeepChatTapeEntryRow = {
        session_id: append.sessionId,
        entry_id: rows.length + 1,
        kind: 'context',
        name: 'skill/materialized',
        source_type: 'runtime_event',
        source_id: append.sourceId,
        source_seq: 0,
        provenance_key: append.provenanceKey,
        payload_json: JSON.stringify(append.payload),
        meta_json: JSON.stringify({ payloadHash: append.payloadHash }),
        created_at: 100 + rows.length
      }
      rows.push(row)
      return row
    },
    runInTransaction: <T>(operation: () => T): T => {
      const snapshot = structuredClone(rows)
      try {
        return operation()
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot)
        throw error
      }
    },
    isInTransaction: () => false
  }
  return {
    rows,
    store,
    setTapeIncarnationId: (value: string) => {
      tapeIncarnationId = value
    },
    failNextAppend: () => {
      failNextAppend = true
    }
  }
}

describe('Tape Skill materialization domain', () => {
  it('computes UTF-8 bytes and validates exact canonical fields', () => {
    const payload = createTapeSkillMaterializationPayload(input())
    expect(payload.byteCount).toBe(Buffer.byteLength('hello 🌍', 'utf8'))
    expect(payload.effectiveContentHash).toBe(hashSkillEffectiveContent('hello 🌍'))
    expect(() => validateTapeSkillMaterializationPayload({ ...payload, extra: true })).toThrow(
      'unknown or missing'
    )
    expect(() =>
      validateTapeSkillMaterializationPayload({ ...payload, sourceType: 'unknown' })
    ).toThrow('supported Skill source type')
  })

  it('fails rather than truncating body, count, and aggregate overflow', () => {
    expect(() => createTapeSkillMaterializationPayload(input('x'.repeat(512 * 1024 + 1)))).toThrow(
      '512 KiB'
    )
    expect(() =>
      validateTapeSkillMaterializationBatch(Array.from({ length: 65 }, () => input()))
    ).toThrow('64 bodies')
    expect(() =>
      validateTapeSkillMaterializationBatch(
        Array.from({ length: 5 }, () => input('x'.repeat(512 * 1024)))
      )
    ).toThrow('2 MiB')
  })
})

describe('Tape Skill materialization capability', () => {
  it('recovers content from a manifest-shaped ref and strictly reuses one canonical fact', () => {
    const { rows, store } = createMaterializationStore()
    const service = new TapeSkillMaterializationService({
      getSkillMaterializationStore: () => store
    })
    const first = service.materializeSkillContexts([input()])[0]
    const second = service.materializeSkillContexts([input()])[0]

    expect(second.entryId).toBe(first.entryId)
    expect(rows).toHaveLength(1)
    expect(
      service.readSkillMaterialization(buildTapeSkillMaterializationRef(first)).payload
        .effectiveContent
    ).toBe('hello 🌍')

    expect(() =>
      service.materializeSkillContexts([
        { ...input(), renderedManifestHash: hashSkillEffectiveContent('different manifest') }
      ])
    ).toThrow(/canonical payload conflicts/)
    expect(rows).toHaveLength(1)
  })

  it.each([
    ['kind', (row: DeepChatTapeEntryRow) => (row.kind = 'event')],
    ['name', (row: DeepChatTapeEntryRow) => (row.name = 'skill/other')],
    ['source type', (row: DeepChatTapeEntryRow) => (row.source_type = 'message')],
    ['source sequence', (row: DeepChatTapeEntryRow) => (row.source_seq = 1)],
    ['source identity', (row: DeepChatTapeEntryRow) => (row.source_id = 'other-source')],
    ['provenance', (row: DeepChatTapeEntryRow) => (row.provenance_key = 'other-key')],
    ['payload', (row: DeepChatTapeEntryRow) => (row.payload_json = '{}')],
    ['metadata', (row: DeepChatTapeEntryRow) => (row.meta_json = '{}')]
  ])('fails closed when stored %s is corrupt', (_name, mutate) => {
    const { rows, store } = createMaterializationStore()
    const service = new TapeSkillMaterializationService({
      getSkillMaterializationStore: () => store
    })
    const receipt = service.materializeSkillContexts([input()])[0]
    mutate(rows[0])

    expect(() =>
      service.readSkillMaterialization(buildTapeSkillMaterializationRef(receipt))
    ).toThrow()
  })

  it('rejects Tape reset drift and rolls back a failed materialization batch', () => {
    const { rows, store, setTapeIncarnationId, failNextAppend } = createMaterializationStore()
    const service = new TapeSkillMaterializationService({
      getSkillMaterializationStore: () => store
    })
    const receipt = service.materializeSkillContexts([input()])[0]
    setTapeIncarnationId('incarnation-2')
    expect(() =>
      service.readSkillMaterialization(buildTapeSkillMaterializationRef(receipt))
    ).toThrow('incarnation changed')
    expect(() =>
      service.materializeSkillContexts([{ ...input(), expectedTapeIncarnationId: 'incarnation-2' }])
    ).toThrow(/canonical payload conflicts/)

    rows.splice(0)
    failNextAppend()
    expect(() =>
      service.materializeSkillContexts([
        { ...input('one'), expectedTapeIncarnationId: 'incarnation-2' },
        {
          ...input('two'),
          sourceId: 'source-2',
          skillName: 'skill-2',
          expectedTapeIncarnationId: 'incarnation-2'
        }
      ])
    ).toThrow('injected append failure')
    expect(rows).toEqual([])
  })

  it('checks the appended row instead of trusting persistence output', () => {
    const { rows, store } = createMaterializationStore()
    const append = store.appendSkillMaterialization
    store.appendSkillMaterialization = (candidate) => {
      const row = append(candidate)
      row.meta_json = JSON.stringify({
        payloadHash: buildTapeSkillMaterializationPayloadHash({
          ...candidate.payload,
          effectiveContent: 'different'
        })
      })
      return row
    }
    const service = new TapeSkillMaterializationService({
      getSkillMaterializationStore: () => store
    })

    expect(() => service.materializeSkillContexts([input()])).toThrow(/payload hash is corrupt/)
    expect(rows).toEqual([])
  })
})

const sqliteModule = await import('better-sqlite3-multiple-ciphers').catch(() => null)
const tableModule = sqliteModule
  ? await import('@/tape/infrastructure/sqlite/tapeEntryStore')
  : null
const Database = sqliteModule?.default
const Table = tableModule?.DeepChatTapeEntriesTable
let sqliteAvailable = false
if (Database && Table) {
  try {
    const smoke = new Database(':memory:')
    smoke.close()
    sqliteAvailable = true
  } catch {
    sqliteAvailable = false
  }
}
const describeSqlite = sqliteAvailable ? describe : describe.skip

describeSqlite('Tape Skill materialization SQLite capability', () => {
  it('appends once, strictly reuses, rejects forgery, and fails after reset identity drift', () => {
    const db = new Database!(':memory:')
    const table = new Table!(db)
    table.createTable()
    table.appendAnchor({
      sessionId: 'session-1',
      name: 'session/start',
      state: {},
      meta: { tapeIncarnationId: 'incarnation-1' }
    })
    const service = new TapeSkillMaterializationService({
      getSkillMaterializationStore: () => table
    })
    const first = service.materializeSkillContexts([input()])[0]
    const second = service.materializeSkillContexts([input()])[0]
    expect(second.entryId).toBe(first.entryId)
    expect(
      service.readSkillMaterialization({
        sessionId: first.sessionId,
        entryId: first.entryId,
        kind: 'materialization',
        tapeIncarnationId: first.tapeIncarnationId,
        agentId: first.payload.agentId,
        sourceType: first.payload.sourceType,
        sourceId: first.payload.sourceId,
        skillName: first.payload.skillName,
        effectiveContentHash: first.payload.effectiveContentHash
      }).payload.effectiveContent
    ).toBe('hello 🌍')
    expect(() =>
      table.append({
        sessionId: 'session-1',
        kind: 'context',
        name: 'skill/materialized',
        payload: {}
      })
    ).toThrow('reserved')
    expect(table.search('session-1', 'hello 🌍')).toEqual([])
    expect(table.search('session-1', 'hello 🌍', { kinds: ['context'] })).toEqual([])
    expect(
      table.getBySessionExcludingContext('session-1').some((row) => row.kind === 'context')
    ).toBe(false)
    db.prepare("UPDATE deepchat_tape_entries SET meta_json = ? WHERE name = 'session/start'").run(
      JSON.stringify({ tapeIncarnationId: 'incarnation-2' })
    )
    expect(() => service.readSkillMaterialization(buildTapeSkillMaterializationRef(first))).toThrow(
      'incarnation changed'
    )
    db.close()
  })

  it('fails closed when a same-key row payload is corrupt', () => {
    const db = new Database!(':memory:')
    const table = new Table!(db)
    table.createTable()
    table.appendAnchor({
      sessionId: 'session-1',
      name: 'session/start',
      state: {},
      meta: { tapeIncarnationId: 'incarnation-1' }
    })
    const service = new TapeSkillMaterializationService({
      getSkillMaterializationStore: () => table
    })
    const receipt = service.materializeSkillContexts([input()])[0]
    db.prepare('UPDATE deepchat_tape_entries SET payload_json = ? WHERE entry_id = ?').run(
      '{}',
      receipt.entryId
    )
    expect(() => service.materializeSkillContexts([input()])).toThrow()
    db.close()
  })
})
