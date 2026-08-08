import { expect, it } from 'vitest'
import { Database, nativeSqliteItIf } from '../nativeSqliteHarness'
import { buildTaskContract } from '@/tape/domain/taskContract'
import { buildEffectiveTapeView } from '@/tape/domain/effectiveView'

const tapeStoreModule = Database
  ? await import('@/tape/infrastructure/sqlite/tapeEntryStore').catch(() => null)
  : null
const serviceModule = Database
  ? await import('@/tape/application/taskContractService').catch(() => null)
  : null

const DatabaseCtor = Database!
const DeepChatTapeEntriesTableCtor = tapeStoreModule?.DeepChatTapeEntriesTable!
const DeepChatContractStoreCtor = tapeStoreModule?.DeepChatContractStore!
const TaskContractServiceCtor = serviceModule?.TaskContractService!
const itIfSqlite = nativeSqliteItIf(
  Boolean(DeepChatTapeEntriesTableCtor && DeepChatContractStoreCtor && TaskContractServiceCtor),
  'TaskContract persistence modules are unavailable'
)

function contract(title = 'Review boundaries') {
  return buildTaskContract({
    delegationId: 'delegation-1',
    turnId: 'turn-1',
    turnSeq: 1,
    turnKind: 'initial',
    parentSessionId: 'parent-1',
    slotId: 'reviewer',
    targetAgentId: 'agent-1',
    title,
    prompt: 'Inspect the contract boundary.',
    workspace: { kind: 'runtime_default' },
    acceptance: [
      {
        id: 'sections',
        kind: 'required_sections',
        level: 2,
        sections: ['Handoff']
      }
    ]
  })
}

itIfSqlite(
  'keeps contract facts strict, transaction-aware, and out of default Context Views',
  () => {
    const db = new DatabaseCtor(':memory:')
    try {
      const genericStore = new DeepChatTapeEntriesTableCtor(db)
      genericStore.createTable()
      const contractStore = new DeepChatContractStoreCtor(db)
      const service = new TaskContractServiceCtor(() => contractStore)

      expect(() =>
        genericStore.appendEvent({
          sessionId: 'parent-1',
          name: 'contract/task_frozen',
          data: {}
        })
      ).toThrow(/reserved for the strict Contract writer/u)
      expect(() =>
        contractStore.append({
          sessionId: 'parent-1',
          kind: 'event',
          name: 'execution/run_started',
          payload: {}
        })
      ).toThrow(/reserved for the strict Execution Journal writer/u)
      expect('appendExecutionJournalEvent' in contractStore).toBe(false)
      expect(() =>
        service.freezeParentTaskContract({ parentSessionId: 'parent-1', contract: contract() })
      ).toThrow(/requires the live-delegation host transaction/u)

      expect(() =>
        contractStore.runInTransaction(() => {
          service.freezeParentTaskContract({ parentSessionId: 'parent-1', contract: contract() })
          throw new Error('roll back host mutation')
        })
      ).toThrow('roll back host mutation')
      expect(contractStore.getBySession('parent-1')).toEqual([])

      const first = contractStore.runInTransaction(() =>
        service.freezeParentTaskContract({
          parentSessionId: 'parent-1',
          contract: contract(),
          createdAt: 100
        })
      )
      const retry = contractStore.runInTransaction(() =>
        service.freezeParentTaskContract({
          parentSessionId: 'parent-1',
          contract: contract(),
          createdAt: 200
        })
      )
      expect(first).toMatchObject({ created: true, ref: { sessionId: 'parent-1', entryId: 2 } })
      expect(retry).toMatchObject({ created: false, ref: first.ref })
      expect(() =>
        contractStore.runInTransaction(() =>
          service.freezeParentTaskContract({
            parentSessionId: 'parent-1',
            contract: contract('Conflicting title')
          })
        )
      ).toThrow(/conflicts with turn turn-1/u)

      const rows = contractStore.getBySession('parent-1')
      expect(rows.filter((row) => row.name === 'contract/task_frozen')).toHaveLength(1)
      expect(buildEffectiveTapeView(rows).rows.map((row) => row.name)).not.toContain(
        'contract/task_frozen'
      )
      expect(
        buildEffectiveTapeView(rows, { includeAuditEvents: true }).rows.map((row) => row.name)
      ).toContain('contract/task_frozen')

      db.prepare(
        `INSERT INTO deepchat_tape_entries (
         session_id, entry_id, kind, name, payload_json, meta_json, created_at
       ) VALUES ('parent-1', 3, 'event', 'contract/future_fact',
         '{"marker":"future-contract-marker"}', '{}', 300)`
      ).run()
      const rowsWithFutureFact = contractStore.getBySession('parent-1')
      expect(buildEffectiveTapeView(rowsWithFutureFact).rows.map((row) => row.name)).not.toContain(
        'contract/future_fact'
      )
      expect(
        contractStore.searchEffectiveSourcesAtHeads(
          [{ sessionId: 'parent-1', maxEntryId: 3 }],
          'future-contract-marker'
        )
      ).toEqual([])
      expect(
        contractStore.getEffectiveContextRowsAtHead({ sessionId: 'parent-1', maxEntryId: 3 }, [3], {
          before: 0,
          after: 0,
          limit: 10
        })
      ).toEqual([])
    } finally {
      db.close()
    }
  }
)
