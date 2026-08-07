import {
  EXECUTION_JOURNAL_EVENT_NAMES,
  EXECUTION_JOURNAL_PROTOCOL_VERSION,
  ExecutionJournalCorruptionError,
  ExecutionJournalError,
  buildDispatchData,
  buildExecutionJournalMeta,
  buildExecutionOperationProvenanceKey,
  buildExecutionRunProvenanceKey,
  buildRunStartedData,
  buildRunTerminalData,
  buildToolOutcomeData,
  classifyExecutionJournalRows,
  isExecutionJournalError,
  parseExecutionJournalFact,
  type CommitExecutionDispatchInput,
  type CommitExecutionRunStartedInput,
  type CommitExecutionRunTerminalInput,
  type CommitExecutionToolOutcomeInput,
  type ExecutionJournalCommitReceipt,
  type ExecutionJournalEventName,
  type ExecutionRecoveryReport
} from '../domain/executionJournal'
import type { DeepChatTapeEntryRow, TapeEventAppendInput } from '../domain/entry'
import { stableJsonStringify } from '../domain/canonicalJson'
import type { ExecutionJournalRecoveryReader, ExecutionJournalWriter } from '../ports/capabilities'
import type { TapeApplicationEntryStore, TapeApplicationProviders } from '../ports/application'

type ExecutionJournalProviders = Pick<TapeApplicationProviders, 'getEntryStore'>

type StrictEventInput = TapeEventAppendInput & {
  source: NonNullable<TapeEventAppendInput['source']>
  provenanceKey: string
}

function canonicalJsonEquals(raw: string, expected: unknown): boolean {
  try {
    return stableJsonStringify(JSON.parse(raw)) === stableJsonStringify(expected)
  } catch {
    return false
  }
}

function rowMatchesStrictEvent(row: DeepChatTapeEntryRow, input: StrictEventInput): boolean {
  return (
    row.session_id === input.sessionId &&
    row.kind === 'event' &&
    row.name === input.name &&
    row.source_type === input.source.type &&
    row.source_id === input.source.id &&
    row.source_seq === (input.source.seq ?? null) &&
    row.provenance_key === input.provenanceKey &&
    canonicalJsonEquals(row.payload_json, { name: input.name, data: input.data }) &&
    canonicalJsonEquals(row.meta_json, input.meta ?? {})
  )
}

export class ExecutionJournalService
  implements ExecutionJournalWriter, ExecutionJournalRecoveryReader
{
  constructor(private readonly providers: ExecutionJournalProviders) {}

  commitRunStarted(input: CommitExecutionRunStartedInput): ExecutionJournalCommitReceipt {
    const data = buildRunStartedData(input)
    return this.commitStrictEvent({
      sessionId: input.sessionId,
      name: 'execution/run_started',
      data,
      source: { type: 'runtime_event', id: data.runId, seq: 0 },
      provenanceKey: buildExecutionRunProvenanceKey(data.runId, 'started'),
      meta: buildExecutionJournalMeta(),
      createdAt: input.createdAt
    })
  }

  commitDispatch(input: CommitExecutionDispatchInput): ExecutionJournalCommitReceipt {
    const data = buildDispatchData(input)
    return this.commitStrictEvent(
      {
        sessionId: input.sessionId,
        name: 'execution/dispatch_committed',
        data,
        source: {
          type: 'runtime_event',
          id: data.operation.runId,
          seq: data.operation.requestSeq
        },
        provenanceKey: buildExecutionOperationProvenanceKey(data.operation, 'dispatch'),
        meta: buildExecutionJournalMeta(),
        createdAt: input.createdAt
      },
      (table) =>
        this.requireFact(
          table,
          input.sessionId,
          buildExecutionRunProvenanceKey(data.operation.runId, 'started'),
          'execution/run_started',
          data.messageId
        ),
      (table) => this.requireRunOpen(table, input.sessionId, data.operation.runId)
    )
  }

  commitToolOutcome(input: CommitExecutionToolOutcomeInput): ExecutionJournalCommitReceipt {
    const data = buildToolOutcomeData(input)
    return this.commitStrictEvent(
      {
        sessionId: input.sessionId,
        name: 'execution/tool_outcome',
        data,
        source: {
          type: 'runtime_event',
          id: data.operation.runId,
          seq: data.operation.requestSeq
        },
        provenanceKey: buildExecutionOperationProvenanceKey(data.operation, 'outcome'),
        meta: buildExecutionJournalMeta(),
        createdAt: input.createdAt
      },
      (table) =>
        this.requireFact(
          table,
          input.sessionId,
          buildExecutionOperationProvenanceKey(data.operation, 'dispatch'),
          'execution/dispatch_committed',
          data.messageId
        ),
      (table) => this.requireRunOpen(table, input.sessionId, data.operation.runId)
    )
  }

  commitRunTerminal(input: CommitExecutionRunTerminalInput): ExecutionJournalCommitReceipt {
    const data = buildRunTerminalData(input)
    return this.commitStrictEvent(
      {
        sessionId: input.sessionId,
        name: 'execution/run_terminal',
        data,
        source: { type: 'runtime_event', id: data.runId, seq: 0 },
        provenanceKey: buildExecutionRunProvenanceKey(data.runId, 'terminal'),
        meta: buildExecutionJournalMeta(),
        createdAt: input.createdAt
      },
      (table) =>
        this.requireFact(
          table,
          input.sessionId,
          buildExecutionRunProvenanceKey(data.runId, 'started'),
          'execution/run_started',
          data.messageId
        )
    )
  }

  classifyRecoveryCandidates(): ExecutionRecoveryReport[] {
    return classifyExecutionJournalRows(
      this.providers.getEntryStore().listEventsByNames(EXECUTION_JOURNAL_EVENT_NAMES)
    )
  }

  private commitStrictEvent(
    input: StrictEventInput,
    requirePrerequisite?: (table: TapeApplicationEntryStore) => void,
    validateNewFact?: (table: TapeApplicationEntryStore) => void
  ): ExecutionJournalCommitReceipt {
    const table = this.providers.getEntryStore()
    try {
      return table.runInTransaction(() => {
        table.ensureBootstrapAnchor(input.sessionId)
        requirePrerequisite?.(table)
        const existing = table.getByProvenanceKey(input.sessionId, input.provenanceKey)
        if (existing) {
          return this.resolveExisting(existing, input)
        }
        validateNewFact?.(table)

        const row = table.appendEvent({ ...input, idempotent: false })
        if (!rowMatchesStrictEvent(row, input)) {
          throw new ExecutionJournalCorruptionError(
            `Execution Journal append returned a conflicting ${input.name} row.`
          )
        }
        return { sessionId: row.session_id, entryId: row.entry_id, created: true }
      })
    } catch (error) {
      if (isExecutionJournalError(error)) throw error
      throw new ExecutionJournalError(
        `Failed to persist ${input.name} for session ${input.sessionId} (protocol v${EXECUTION_JOURNAL_PROTOCOL_VERSION}).`,
        'persistence_failed',
        { cause: error }
      )
    }
  }

  private requireFact(
    table: TapeApplicationEntryStore,
    sessionId: string,
    provenanceKey: string,
    expectedType: ExecutionJournalEventName,
    expectedMessageId: string
  ): void {
    const row = table.getByProvenanceKey(sessionId, provenanceKey)
    if (!row) {
      throw new ExecutionJournalCorruptionError(
        `Execution Journal prerequisite ${expectedType} is missing in session ${sessionId}.`
      )
    }
    try {
      const fact = parseExecutionJournalFact(row)
      if (fact.type !== expectedType || fact.messageId !== expectedMessageId) {
        throw new ExecutionJournalCorruptionError(
          `Execution Journal prerequisite ${expectedType} has conflicting identity in session ${sessionId}.`
        )
      }
    } catch (error) {
      if (error instanceof ExecutionJournalCorruptionError) throw error
      throw new ExecutionJournalCorruptionError(
        `Execution Journal prerequisite ${expectedType} is malformed in session ${sessionId}.`,
        { cause: error }
      )
    }
  }

  private requireRunOpen(table: TapeApplicationEntryStore, sessionId: string, runId: string): void {
    const terminal = table.getByProvenanceKey(
      sessionId,
      buildExecutionRunProvenanceKey(runId, 'terminal')
    )
    if (terminal) {
      throw new ExecutionJournalCorruptionError(
        `Execution Journal cannot append an operation fact after run_terminal in session ${sessionId}.`
      )
    }
  }

  private resolveExisting(
    row: DeepChatTapeEntryRow,
    input: StrictEventInput
  ): ExecutionJournalCommitReceipt {
    if (!rowMatchesStrictEvent(row, input)) {
      throw new ExecutionJournalCorruptionError(
        `Execution Journal identity collision for ${input.name} in session ${input.sessionId}.`
      )
    }
    return { sessionId: row.session_id, entryId: row.entry_id, created: false }
  }
}
