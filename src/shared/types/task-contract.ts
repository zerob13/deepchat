import { z } from 'zod'
import { JsonValueSchema, type JsonValue } from '../contracts/json'

export const DEEPCHAT_TASK_CONTRACT_SCHEMA_VERSION = 1 as const
export const DEEPCHAT_TASK_CONTRACT_HASH_VERSION = 1 as const
export const DEEPCHAT_TASK_CONTRACT_REF_SCHEMA_VERSION = 1 as const
export const DEEPCHAT_EVALUATION_REF_SCHEMA_VERSION = 1 as const

export const MAX_TASK_CONTRACT_BYTES = 128 * 1024
export const MAX_TASK_CONTRACT_REQUIREMENTS = 64
export const MAX_TASK_CONTRACT_RESULT_SCHEMA_BYTES = 32 * 1024
export const MAX_TASK_CONTRACT_REF_BYTES = 4 * 1024
export const MAX_TASK_EVALUATION_BYTES = 32 * 1024

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
