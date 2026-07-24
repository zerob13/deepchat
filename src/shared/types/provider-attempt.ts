export interface DeepChatProviderAttemptIdentity {
  logicalRound: number
  requestSeq: number
  physicalAttempt: number
}

export type DeepChatProviderRequestOrigin = 'chat' | 'resume' | 'tool_loop' | 'context_recovery'

export type DeepChatProviderAttemptOrigin = 'initial' | 'transient_retry'

export type DeepChatProviderFailureClassification =
  | 'aborted'
  | 'context_overflow'
  | 'permanent'
  | 'transient'
  | 'unknown'

export type DeepChatProviderRetryDecision =
  | 'none'
  | 'retry_scheduled'
  | 'context_recovery_scheduled'
  | 'context_recovery_exhausted'
  | 'not_retryable'
  | 'retry_budget_exhausted'
  | 'output_committed'
  | 'retry_after_exceeds_limit'
