import { z } from 'zod'
import { JsonValueSchema, type JsonValue } from '../contracts/json'

export const DEEPCHAT_TASK_CONTRACT_SCHEMA_VERSION = 1 as const
export const DEEPCHAT_TASK_CONTRACT_HASH_VERSION = 1 as const
export const DEEPCHAT_TASK_CONTRACT_REF_SCHEMA_VERSION = 1 as const
export const DEEPCHAT_TASK_EVALUATION_SCHEMA_VERSION = 1 as const
export const DEEPCHAT_TASK_EVALUATION_HASH_VERSION = 1 as const
export const DEEPCHAT_TASK_EVALUATOR_VERSION = 'task-contract-v1' as const
export const DEEPCHAT_EVALUATION_REF_SCHEMA_VERSION = 1 as const

export const MAX_TASK_CONTRACT_BYTES = 128 * 1024
export const MAX_TASK_CONTRACT_REQUIREMENTS = 64
export const MAX_TASK_CONTRACT_RESULT_SCHEMA_BYTES = 32 * 1024
export const MAX_TASK_CONTRACT_REF_BYTES = 4 * 1024
export const MAX_TASK_EVALUATION_BYTES = 32 * 1024
export const MAX_TASK_EVALUATION_REF_BYTES = 4 * 1024
export const MAX_TASK_EVALUATION_RECORDS = 64
export const MAX_TASK_EVALUATION_PARENT_EVIDENCE = 16
export const MAX_TASK_EVALUATION_CANDIDATE_BYTES = 1024 * 1024

export const DEEPCHAT_TASK_EVALUATION_REASON_CODES = [
  'candidate_missing',
  'candidate_too_large',
  'candidate_too_complex',
  'execution_cancelled',
  'execution_interrupted',
  'required_sections_present',
  'required_sections_missing',
  'result_schema_valid',
  'result_section_missing',
  'result_json_invalid',
  'result_schema_mismatch',
  'evaluator_error'
] as const

export type DeepChatTaskEvaluationReasonCode =
  (typeof DEEPCHAT_TASK_EVALUATION_REASON_CODES)[number]
export type DeepChatTaskEvaluationVerdict = 'passed' | 'failed' | 'indeterminate'
export type DeepChatTaskEvaluationDisposition = 'accepted' | 'parked'
export type DeepChatTaskEvaluationExecutionStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export type DeepChatTaskEvaluationOutcome = 'passed' | 'failed' | 'indeterminate'

export interface DeepChatTaskContractRef {
  readonly schemaVersion: typeof DEEPCHAT_TASK_CONTRACT_REF_SCHEMA_VERSION
  readonly sessionId: string
  readonly tapeIdentity: string
  readonly entryId: number
  readonly contractHash: string
}

export interface DeepChatEvaluationRef {
  readonly schemaVersion: typeof DEEPCHAT_EVALUATION_REF_SCHEMA_VERSION
  readonly sessionId: string
  readonly tapeIdentity: string
  readonly entryId: number
  readonly evaluationHash: string
}

export type DeepChatTaskEvaluationCandidate =
  | {
      readonly kind: 'answer'
      readonly sha256: string
      readonly utf8Bytes: number
    }
  | {
      readonly kind: 'absent'
    }

export interface DeepChatTaskEvaluationRecord {
  readonly requirementId: string | null
  readonly requirementKind: 'required_sections' | 'result_schema' | null
  readonly outcome: DeepChatTaskEvaluationOutcome
  readonly code: DeepChatTaskEvaluationReasonCode
  readonly section: string | null
  readonly instancePath: string | null
  readonly keyword: string | null
  readonly additionalEvidenceCount: number
}

export interface DeepChatTaskEvaluation {
  readonly schemaVersion: typeof DEEPCHAT_TASK_EVALUATION_SCHEMA_VERSION
  readonly hashVersion: typeof DEEPCHAT_TASK_EVALUATION_HASH_VERSION
  readonly evaluatorVersion: typeof DEEPCHAT_TASK_EVALUATOR_VERSION
  readonly turnId: string
  readonly taskContractHash: string
  readonly candidate: DeepChatTaskEvaluationCandidate
  readonly executionStatus: DeepChatTaskEvaluationExecutionStatus
  readonly verdict: DeepChatTaskEvaluationVerdict
  readonly disposition: DeepChatTaskEvaluationDisposition
  readonly reasonCodes: readonly DeepChatTaskEvaluationReasonCode[]
  readonly records: readonly DeepChatTaskEvaluationRecord[]
  readonly omittedRecordCount: number
  readonly evaluationHash: string
}

export interface DeepChatTaskEvaluationSummary {
  readonly verdict: DeepChatTaskEvaluationVerdict
  readonly disposition: DeepChatTaskEvaluationDisposition
  readonly reasonCodes: readonly DeepChatTaskEvaluationReasonCode[]
  readonly candidate: DeepChatTaskEvaluationCandidate
  readonly evidence: readonly DeepChatTaskEvaluationRecord[]
  readonly evaluationRef: DeepChatEvaluationRef
  readonly omittedEvidenceCount: number
}

export interface DeepChatTaskSchema {
  readonly input: {
    readonly kind: 'text'
    readonly maxBytes: number
  }
  readonly output: {
    readonly kind: 'markdown'
  }
}

export interface DeepChatTaskConfig {
  readonly completionMode: 'single_response'
  readonly retryMode: 'parent_follow_up'
  readonly creationReason: 'delegation_created' | 'legacy_recovery'
  readonly predecessorEvaluationRef: DeepChatEvaluationRef | null
}

export interface DeepChatTaskDescription {
  readonly delegationId: string
  readonly turnId: string
  readonly turnSeq: number
  readonly turnKind: 'initial' | 'follow_up'
  readonly parentSessionId: string
  readonly slotId: string
  readonly targetAgentId: string
  readonly title: string
  readonly prompt: string
}

export type DeepChatTaskWorkspaceCeiling =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'runtime_default' }

export interface DeepChatRequiredSectionsAcceptance {
  readonly id: string
  readonly kind: 'required_sections'
  readonly level: 2
  readonly sections: readonly string[]
}

export interface DeepChatResultSchemaAcceptance {
  readonly id: string
  readonly kind: 'result_schema'
  readonly section: string
  readonly schema: JsonValue
}

export type DeepChatTaskAcceptanceRequirement =
  | DeepChatRequiredSectionsAcceptance
  | DeepChatResultSchemaAcceptance

export interface DeepChatTaskHarness {
  readonly acceptance: readonly DeepChatTaskAcceptanceRequirement[]
  readonly ceilings: {
    readonly maxToolEffect: 'read' | 'write'
    readonly workspace: DeepChatTaskWorkspaceCeiling
    readonly maxSubagentDepth: number
  }
}

export interface DeepChatTaskContract {
  readonly schemaVersion: typeof DEEPCHAT_TASK_CONTRACT_SCHEMA_VERSION
  readonly hashVersion: typeof DEEPCHAT_TASK_CONTRACT_HASH_VERSION
  readonly taskSchema: DeepChatTaskSchema
  readonly taskConfig: DeepChatTaskConfig
  readonly taskDescription: DeepChatTaskDescription
  readonly taskHarness: DeepChatTaskHarness
  readonly contractHash: string
}

export interface DeepChatTaskContractContext {
  readonly contract: DeepChatTaskContract
  readonly localRef: DeepChatTaskContractRef
}

const StoredIdSchema = z.string().trim().min(1).max(256)
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)

export const DeepChatTaskContractRefSchema = z
  .object({
    schemaVersion: z.literal(DEEPCHAT_TASK_CONTRACT_REF_SCHEMA_VERSION),
    sessionId: StoredIdSchema,
    tapeIdentity: Sha256Schema,
    entryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contractHash: Sha256Schema
  })
  .strict()

export const DeepChatEvaluationRefSchema = z
  .object({
    schemaVersion: z.literal(DEEPCHAT_EVALUATION_REF_SCHEMA_VERSION),
    sessionId: StoredIdSchema,
    tapeIdentity: Sha256Schema,
    entryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    evaluationHash: Sha256Schema
  })
  .strict()

export const DeepChatTaskEvaluationCandidateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('answer'),
      sha256: Sha256Schema,
      utf8Bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .strict(),
  z.object({ kind: z.literal('absent') }).strict()
])

export const DeepChatTaskEvaluationReasonCodeSchema = z.enum(DEEPCHAT_TASK_EVALUATION_REASON_CODES)

export const DeepChatTaskEvaluationRecordSchema = z
  .object({
    requirementId: StoredIdSchema.nullable(),
    requirementKind: z.enum(['required_sections', 'result_schema']).nullable(),
    outcome: z.enum(['passed', 'failed', 'indeterminate']),
    code: DeepChatTaskEvaluationReasonCodeSchema,
    section: z.string().trim().min(1).max(256).nullable(),
    instancePath: z.string().max(1024).nullable(),
    keyword: z.string().trim().min(1).max(128).nullable(),
    additionalEvidenceCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

export const DeepChatTaskEvaluationProjectionSchema: z.ZodType<DeepChatTaskEvaluation> = z
  .object({
    schemaVersion: z.literal(DEEPCHAT_TASK_EVALUATION_SCHEMA_VERSION),
    hashVersion: z.literal(DEEPCHAT_TASK_EVALUATION_HASH_VERSION),
    evaluatorVersion: z.literal(DEEPCHAT_TASK_EVALUATOR_VERSION),
    turnId: StoredIdSchema,
    taskContractHash: Sha256Schema,
    candidate: DeepChatTaskEvaluationCandidateSchema,
    executionStatus: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
    verdict: z.enum(['passed', 'failed', 'indeterminate']),
    disposition: z.enum(['accepted', 'parked']),
    reasonCodes: z.array(DeepChatTaskEvaluationReasonCodeSchema),
    records: z.array(DeepChatTaskEvaluationRecordSchema).max(MAX_TASK_EVALUATION_RECORDS),
    omittedRecordCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    evaluationHash: Sha256Schema
  })
  .strict()
  .superRefine((evaluation, context) => {
    if ((evaluation.verdict === 'passed') !== (evaluation.disposition === 'accepted')) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Only a passed evaluation may be accepted'
      })
    }
  })

export const DeepChatTaskEvaluationSummarySchema: z.ZodType<DeepChatTaskEvaluationSummary> = z
  .object({
    verdict: z.enum(['passed', 'failed', 'indeterminate']),
    disposition: z.enum(['accepted', 'parked']),
    reasonCodes: z.array(DeepChatTaskEvaluationReasonCodeSchema),
    candidate: DeepChatTaskEvaluationCandidateSchema,
    evidence: z.array(DeepChatTaskEvaluationRecordSchema).max(MAX_TASK_EVALUATION_PARENT_EVIDENCE),
    evaluationRef: DeepChatEvaluationRefSchema,
    omittedEvidenceCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
  .superRefine((evaluation, context) => {
    if ((evaluation.verdict === 'passed') !== (evaluation.disposition === 'accepted')) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Only a passed evaluation may be accepted'
      })
    }
  })

const DeepChatTaskWorkspaceCeilingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('runtime_default') }).strict()
])

const DeepChatTaskAcceptanceRequirementSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: StoredIdSchema,
      kind: z.literal('required_sections'),
      level: z.literal(2),
      sections: z.array(z.string().trim().min(1).max(256)).min(1).max(64)
    })
    .strict(),
  z
    .object({
      id: StoredIdSchema,
      kind: z.literal('result_schema'),
      section: z.string().trim().min(1).max(256),
      schema: JsonValueSchema
    })
    .strict()
])

// This validates the persisted/transport shape only. The main-process TaskContract domain owns
// canonical normalization and contractHash verification.
export const DeepChatTaskContractProjectionSchema: z.ZodType<DeepChatTaskContract> = z
  .object({
    schemaVersion: z.literal(DEEPCHAT_TASK_CONTRACT_SCHEMA_VERSION),
    hashVersion: z.literal(DEEPCHAT_TASK_CONTRACT_HASH_VERSION),
    taskSchema: z
      .object({
        input: z
          .object({ kind: z.literal('text'), maxBytes: z.number().int().positive() })
          .strict(),
        output: z.object({ kind: z.literal('markdown') }).strict()
      })
      .strict(),
    taskConfig: z
      .object({
        completionMode: z.literal('single_response'),
        retryMode: z.literal('parent_follow_up'),
        creationReason: z.enum(['delegation_created', 'legacy_recovery']),
        predecessorEvaluationRef: DeepChatEvaluationRefSchema.nullable()
      })
      .strict(),
    taskDescription: z
      .object({
        delegationId: StoredIdSchema,
        turnId: StoredIdSchema,
        turnSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        turnKind: z.enum(['initial', 'follow_up']),
        parentSessionId: StoredIdSchema,
        slotId: StoredIdSchema,
        targetAgentId: StoredIdSchema,
        title: z.string().trim().min(1).max(160),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(64 * 1024)
      })
      .strict(),
    taskHarness: z
      .object({
        acceptance: z
          .array(DeepChatTaskAcceptanceRequirementSchema)
          .max(MAX_TASK_CONTRACT_REQUIREMENTS),
        ceilings: z
          .object({
            maxToolEffect: z.enum(['read', 'write']),
            workspace: DeepChatTaskWorkspaceCeilingSchema,
            maxSubagentDepth: z.number().int().nonnegative().max(1)
          })
          .strict()
      })
      .strict(),
    contractHash: Sha256Schema
  })
  .strict()
