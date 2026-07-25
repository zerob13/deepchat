import type {
  AttachmentPreparationSummary,
  MessageStartResult,
  PendingInputEnqueueSource,
  PendingSessionInputRecord
} from '@shared/types/agent-interface'

export type PendingInputTurnSource = PendingInputEnqueueSource | 'steer'

export type ClaimedInputDisposition =
  | { kind: 'consume' }
  | { kind: 'block'; attachmentPreparation: AttachmentPreparationSummary }
  | { kind: 'release-before-user-fact' }
  | { kind: 'release-after-rollback' }

export interface ClaimedPendingInputHandle {
  readonly id: string
  readonly source: PendingInputTurnSource
  readonly disposition: ClaimedInputDisposition | null

  settle(disposition: ClaimedInputDisposition): PendingSessionInputRecord | null
}

export interface TurnCompletion {
  readonly messageStart: MessageStartResult
  readonly claimedInputDisposition: ClaimedInputDisposition | null
}
