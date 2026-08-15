import { describe, expect, it } from 'vitest'
import { TapeCompactionUsageService } from '@/tape/application/compactionUsageService'
import {
  buildTapeCompactionModelCallEvent,
  parseTapeCompactionModelCallEvent,
  type TapeCompactionModelCallInput
} from '@/tape/domain/compactionUsage'
import type { DeepChatTapeEntryRow, TapeEventAppendInput } from '@/tape/domain/entry'
import { SessionTranscript } from '@/session/data/transcript'
import { SessionTape } from '@/tape/application/sessionTape'
import { SessionDatabase } from '@/session/data/database'
import { itIfSqlite, DatabaseCtor } from '../session/data/tapeTestHarness'

function input(
  overrides: Partial<TapeCompactionModelCallInput> = {}
): TapeCompactionModelCallInput {
  return {
    sessionId: 'session-1',
    compactionMessageId: 'message-1',
    compactionAttemptId: 'attempt-1',
    providerCallId: 'call-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    status: 'completed',
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    startedAt: 10,
    completedAt: 20,
    ...overrides
  }
}

function createService() {
  const rows: DeepChatTapeEntryRow[] = []
  let inTransaction = false
  const store = {
    ensureBootstrapAnchor: () => undefined,
    isInTransaction: () => inTransaction,
    runInTransaction<T>(operation: () => T): T {
      inTransaction = true
      try {
        return operation()
      } finally {
        inTransaction = false
      }
    },
    getByProvenanceKey(sessionId: string, key: string) {
      return rows.find((row) => row.session_id === sessionId && row.provenance_key === key)
    },
    getMaxEventSourceSeq(sessionId: string, name: string, sourceType: string, sourceId: string) {
      return rows.reduce(
        (maximum, row) =>
          row.session_id === sessionId &&
          row.name === name &&
          row.source_type === sourceType &&
          row.source_id === sourceId
            ? Math.max(maximum, row.source_seq ?? 0)
            : maximum,
        0
      )
    },
    appendEvent(event: TapeEventAppendInput) {
      const row: DeepChatTapeEntryRow = {
        session_id: event.sessionId,
        entry_id: rows.length + 1,
        kind: 'event',
        name: event.name,
        source_type: event.source?.type ?? null,
        source_id: event.source?.id ?? null,
        source_seq: event.source?.seq ?? null,
        provenance_key: event.provenanceKey ?? null,
        payload_json: JSON.stringify({ name: event.name, data: event.data }),
        meta_json: JSON.stringify(event.meta ?? {}),
        created_at: event.createdAt ?? Date.now()
      }
      rows.push(row)
      return row
    }
  }
  return {
    rows,
    service: new TapeCompactionUsageService({ getEntryStore: () => store as never })
  }
}

describe('compaction model call Tape usage', () => {
  it('round-trips known and unknown usage without synthesizing token counts', () => {
    const known = buildTapeCompactionModelCallEvent(input(), 1)
    const unknown = buildTapeCompactionModelCallEvent(
      input({ providerCallId: 'call-2', usage: null, status: 'error' }),
      2
    )
    const { service } = createService()

    const knownRow = service.appendCompactionModelCall(input()).row
    const unknownRow = service.appendCompactionModelCall(
      input({ providerCallId: 'call-2', usage: null, status: 'error' })
    ).row

    expect(parseTapeCompactionModelCallEvent(knownRow)).toEqual(known)
    expect(parseTapeCompactionModelCallEvent(unknownRow)).toEqual(unknown)
  })

  it('round-trips partial usage and keeps legacy complete-usage facts readable', () => {
    const { service } = createService()
    const partialRow = service.appendCompactionModelCall(
      input({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: null } })
    ).row
    const legacyRow: DeepChatTapeEntryRow = {
      ...partialRow,
      payload_json: partialRow.payload_json
        .replace('"schemaVersion":2', '"schemaVersion":1')
        .replace('"totalTokens":null', '"totalTokens":120')
    }

    expect(parseTapeCompactionModelCallEvent(partialRow)?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: null
    })
    expect(parseTapeCompactionModelCallEvent(legacyRow)).toMatchObject({
      schemaVersion: 1,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    })
  })

  it('assigns monotonic attempt-local sequences and reuses an idempotent call identity', () => {
    const { rows, service } = createService()

    const first = service.appendCompactionModelCall(input())
    const second = service.appendCompactionModelCall(input({ providerCallId: 'call-2' }))
    const replay = service.appendCompactionModelCall(
      input({ usage: null, status: 'error', completedAt: 30 })
    )

    expect(first.event.callSeq).toBe(1)
    expect(second.event.callSeq).toBe(2)
    expect(replay).toEqual(first)
    expect(rows).toHaveLength(2)
  })

  it('rejects malformed usage rather than normalizing it to zero', () => {
    expect(() =>
      buildTapeCompactionModelCallEvent(
        input({ usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 } }),
        1
      )
    ).toThrow('Invalid compaction model call observation')
  })

  it('rejects events whose durable source identity disagrees with the payload', () => {
    const { service } = createService()
    const row = service.appendCompactionModelCall(input()).row
    const mismatched = { ...row, source_id: 'another-attempt' }

    expect(parseTapeCompactionModelCallEvent(mismatched)).toBeNull()
  })
})

itIfSqlite('persists compaction call facts and reporting rows atomically and idempotently', () => {
  const db = new DatabaseCtor(':memory:')
  try {
    const database = new SessionDatabase({ getDatabase: () => db })
    database.deepchatTapeEntriesTable.createTable()
    database.deepchatUsageStatsTable.createTable()
    const transcript = new SessionTranscript(database, new SessionTape(database))

    transcript.recordCompactionModelCall(input())
    transcript.recordCompactionModelCall(input())
    transcript.recordCompactionModelCall(
      input({ providerCallId: 'call-2', status: 'error', usage: null, completedAt: 30 })
    )

    const tapeRows = db
      .prepare(
        `SELECT source_seq, provenance_key
         FROM deepchat_tape_entries
         WHERE kind = 'event' AND name = 'compaction/model_call_completed'
         ORDER BY entry_id ASC`
      )
      .all()
    const usageRows = db
      .prepare(
        `SELECT usage_category, provider_call_id, provider_call_seq, input_tokens, total_tokens
         FROM deepchat_usage_stats
         ORDER BY provider_call_seq ASC`
      )
      .all()

    expect(tapeRows).toEqual([
      {
        source_seq: 1,
        provenance_key: 'compaction-model-call:attempt-1:call-1'
      },
      {
        source_seq: 2,
        provenance_key: 'compaction-model-call:attempt-1:call-2'
      }
    ])
    expect(usageRows).toEqual([
      {
        usage_category: 'compaction',
        provider_call_id: 'call-1',
        provider_call_seq: 1,
        input_tokens: 100,
        total_tokens: 120
      },
      {
        usage_category: 'compaction',
        provider_call_id: 'call-2',
        provider_call_seq: 2,
        input_tokens: null,
        total_tokens: null
      }
    ])

    db.exec('DROP TABLE deepchat_usage_stats')
    expect(() =>
      transcript.recordCompactionModelCall(input({ providerCallId: 'call-3' }))
    ).toThrow()
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM deepchat_tape_entries
           WHERE kind = 'event' AND name = 'compaction/model_call_completed'`
        )
        .get()
    ).toEqual({ count: 2 })
  } finally {
    db.close()
  }
})

itIfSqlite('aggregates independently measured compaction usage fields with real SQL', () => {
  const db = new DatabaseCtor(':memory:')
  try {
    const database = new SessionDatabase({ getDatabase: () => db })
    database.deepchatTapeEntriesTable.createTable()
    database.deepchatUsageStatsTable.createTable()
    const transcript = new SessionTranscript(database, new SessionTape(database))

    transcript.recordCompactionModelCall(
      input({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: null } })
    )
    transcript.recordCompactionModelCall(
      input({ providerCallId: 'call-2', usage: null, status: 'error' })
    )

    expect(database.deepchatUsageStatsTable.getProviderBreakdownRows()).toEqual([
      {
        id: 'provider-1',
        messageCount: 0,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 0,
        cachedInputTokens: 0
      }
    ])
    expect(database.deepchatUsageStatsTable.getCategoryBreakdownRows()).toEqual([
      {
        id: 'compaction',
        eventCount: 2,
        knownUsageCount: 1,
        unknownUsageCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 0
      }
    ])
  } finally {
    db.close()
  }
})
