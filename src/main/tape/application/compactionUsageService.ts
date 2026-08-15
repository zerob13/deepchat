import {
  buildTapeCompactionModelCallEvent,
  parseTapeCompactionModelCallEvent,
  TAPE_COMPACTION_MODEL_CALL_EVENT_NAME,
  type TapeCompactionModelCallInput,
  type TapeCompactionModelCallReceipt
} from '../domain/compactionUsage'
import type { TapeApplicationProviders } from '../ports/application'
import type { TapeCompactionModelCallWriter } from '../ports/capabilities'

type TapeCompactionUsageProviders = Pick<TapeApplicationProviders, 'getEntryStore'>

function provenanceKey(input: TapeCompactionModelCallInput): string {
  return `compaction-model-call:${input.compactionAttemptId}:${input.providerCallId}`
}

export class TapeCompactionUsageService implements TapeCompactionModelCallWriter {
  constructor(private readonly providers: TapeCompactionUsageProviders) {}

  appendCompactionModelCall(input: TapeCompactionModelCallInput): TapeCompactionModelCallReceipt {
    const table = this.providers.getEntryStore()
    const append = (): TapeCompactionModelCallReceipt => {
      table.ensureBootstrapAnchor(input.sessionId)
      const key = provenanceKey(input)
      const existing = table.getByProvenanceKey(input.sessionId, key)
      if (existing) {
        const event = parseTapeCompactionModelCallEvent(existing)
        if (!event) {
          throw new Error('Compaction model call provenance resolved to an invalid Tape event.')
        }
        return { row: existing, event }
      }

      const callSeq =
        table.getMaxEventSourceSeq(
          input.sessionId,
          TAPE_COMPACTION_MODEL_CALL_EVENT_NAME,
          'runtime_event',
          input.compactionAttemptId
        ) + 1
      const event = buildTapeCompactionModelCallEvent(input, callSeq)
      const row = table.appendEvent({
        sessionId: input.sessionId,
        name: TAPE_COMPACTION_MODEL_CALL_EVENT_NAME,
        source: {
          type: 'runtime_event',
          id: event.compactionAttemptId,
          seq: event.callSeq
        },
        provenanceKey: key,
        data: { ...event },
        createdAt: event.completedAt,
        idempotent: true
      })
      return { row, event }
    }

    return table.isInTransaction() ? append() : table.runInTransaction(append)
  }
}
