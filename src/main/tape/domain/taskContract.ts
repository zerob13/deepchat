import { Buffer } from 'node:buffer'
import path from 'node:path'
import {
  DEEPCHAT_TASK_CONTRACT_HASH_VERSION,
  DEEPCHAT_TASK_CONTRACT_SCHEMA_VERSION,
  MAX_TASK_CONTRACT_BYTES,
  MAX_TASK_CONTRACT_REQUIREMENTS,
  MAX_TASK_CONTRACT_RESULT_SCHEMA_BYTES,
  type DeepChatEvaluationRef,
  type DeepChatTaskAcceptanceRequirement,
  type DeepChatTaskContract,
  type DeepChatTaskContractRef,
  type DeepChatTaskWorkspaceCeiling
} from '@shared/types/task-contract'
import type { JsonValue } from '@shared/contracts/json'
import { canonicalJsonStringifyData, hashJsonData } from './canonicalJson'

const MAX_IDENTITY_BYTES = 1_024
const MAX_TITLE_BYTES = 1_024
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_SECTION_NAME_BYTES = 256
const MAX_WORKSPACE_PATH_BYTES = 32 * 1024
const MAX_TASK_INPUT_BYTES = 64 * 1024
const MAX_SUBAGENT_DEPTH = 1
const MAX_RESULT_SCHEMA_DEPTH = 64
const MAX_RESULT_SCHEMA_NODES = 4_096
const SHA_256_PATTERN = /^[0-9a-f]{64}$/u

const TASK_CONTRACT_KEYS = [
  'schemaVersion',
  'hashVersion',
  'taskSchema',
  'taskConfig',
  'taskDescription',
  'taskHarness',
  'contractHash'
] as const

const TASK_CONTRACT_REF_KEYS = [
  'schemaVersion',
  'sessionId',
  'tapeIdentity',
  'entryId',
  'contractHash'
] as const

export interface BuildTaskContractInput {
  delegationId: string
  turnId: string
  turnSeq: number
  turnKind: 'initial' | 'follow_up'
  parentSessionId: string
  slotId: string
  targetAgentId: string
  title: string
  prompt: string
  workspace: DeepChatTaskWorkspaceCeiling
  acceptance: readonly DeepChatTaskAcceptanceRequirement[]
  creationReason?: 'delegation_created' | 'legacy_recovery'
  predecessorEvaluationRef?: DeepChatEvaluationRef | null
  maxToolEffect?: 'read' | 'write'
  maxSubagentDepth?: number
}

export class TaskContractError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'limit_exceeded',
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'TaskContractError'
  }
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function requireString(
  value: unknown,
  label: string,
  maxBytes: number,
  maxCharacters?: number
): string {
  if (typeof value !== 'string') {
    throw new TaskContractError(`${label} must be a string.`, 'invalid_input')
  }
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.includes('\0') ||
    utf8Length(normalized) > maxBytes ||
    (maxCharacters !== undefined && normalized.length > maxCharacters)
  ) {
    throw new TaskContractError(
      `${label} must contain between 1 and ${maxBytes} UTF-8 bytes.`,
      'invalid_input'
    )
  }
  return normalized
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TaskContractError(`${label} must be a positive safe integer.`, 'invalid_input')
  }
  return value as number
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TaskContractError(`${label} must be a non-negative safe integer.`, 'invalid_input')
  }
  return value as number
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeWorkspace(workspace: DeepChatTaskWorkspaceCeiling): DeepChatTaskWorkspaceCeiling {
  if (workspace?.kind === 'runtime_default') return { kind: 'runtime_default' }
  if (workspace?.kind !== 'path' || typeof workspace.path !== 'string') {
    throw new TaskContractError('workspace.kind is invalid.', 'invalid_input')
  }
  if (
    !workspace.path ||
    workspace.path.includes('\0') ||
    utf8Length(workspace.path) > MAX_WORKSPACE_PATH_BYTES ||
    !path.isAbsolute(workspace.path)
  ) {
    throw new TaskContractError('workspace.path must be a bounded absolute path.', 'invalid_input')
  }
  return { kind: 'path', path: path.normalize(workspace.path) }
}

function normalizeEvaluationRef(value: DeepChatEvaluationRef | null): DeepChatEvaluationRef | null {
  if (value === null) return null
  const sessionId = requireString(
    value?.sessionId,
    'predecessorEvaluationRef.sessionId',
    MAX_IDENTITY_BYTES,
    256
  )
  const entryId = requirePositiveSafeInteger(value?.entryId, 'predecessorEvaluationRef.entryId')
  if (
    value?.schemaVersion !== 1 ||
    !SHA_256_PATTERN.test(value.tapeIdentity) ||
    !SHA_256_PATTERN.test(value.evaluationHash)
  ) {
    throw new TaskContractError('predecessorEvaluationRef is invalid.', 'invalid_input')
  }
  return {
    schemaVersion: 1,
    sessionId,
    tapeIdentity: value.tapeIdentity,
    entryId,
    evaluationHash: value.evaluationHash
  }
}

function normalizeJsonValue(value: JsonValue, label: string): JsonValue {
  assertBoundedJsonSchema(value, label, 0, { nodes: 0, ancestors: new Set() })
  let serialized: string
  try {
    serialized = canonicalJsonStringifyData(value)
  } catch (error) {
    throw new TaskContractError(`${label} must contain only JSON data.`, 'invalid_input', {
      cause: error
    })
  }
  if (utf8Length(serialized) > MAX_TASK_CONTRACT_RESULT_SCHEMA_BYTES) {
    throw new TaskContractError(
      `${label} exceeds ${MAX_TASK_CONTRACT_RESULT_SCHEMA_BYTES} UTF-8 bytes.`,
      'limit_exceeded'
    )
  }
  const normalized = JSON.parse(serialized) as JsonValue
  return normalized
}

function assertBoundedJsonSchema(
  value: unknown,
  label: string,
  depth: number,
  state: { nodes: number; ancestors: Set<object> }
): void {
  state.nodes += 1
  if (depth > MAX_RESULT_SCHEMA_DEPTH || state.nodes > MAX_RESULT_SCHEMA_NODES) {
    throw new TaskContractError(
      `${label} exceeds the structural complexity limit.`,
      'limit_exceeded'
    )
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (!value || typeof value !== 'object') {
    throw new TaskContractError(`${label} must contain only JSON data.`, 'invalid_input')
  }
  if (state.ancestors.has(value)) {
    throw new TaskContractError(`${label} must not contain circular references.`, 'invalid_input')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TaskContractError(`${label} must not contain symbol properties.`, 'invalid_input')
  }

  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Object.getOwnPropertyNames(value).filter((key) => key !== 'length')
      if (keys.length !== value.length) {
        throw new TaskContractError(`${label} must not contain sparse arrays.`, 'invalid_input')
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TaskContractError(
            `${label} must contain only data properties.`,
            'invalid_input'
          )
        }
        assertBoundedJsonSchema(descriptor.value, label, depth + 1, state)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TaskContractError(`${label} must contain only plain objects.`, 'invalid_input')
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TaskContractError(`${label} must contain only data properties.`, 'invalid_input')
      }
      if (key === '$ref') {
        throw new TaskContractError(`${label} must not contain $ref.`, 'invalid_input')
      }
      assertBoundedJsonSchema(descriptor.value, label, depth + 1, state)
    }
  } finally {
    state.ancestors.delete(value)
  }
}

function normalizeAcceptance(
  requirements: readonly DeepChatTaskAcceptanceRequirement[]
): DeepChatTaskAcceptanceRequirement[] {
  if (!Array.isArray(requirements)) {
    throw new TaskContractError('acceptance must be an array.', 'invalid_input')
  }
  if (requirements.length > MAX_TASK_CONTRACT_REQUIREMENTS) {
    throw new TaskContractError(
      `acceptance exceeds ${MAX_TASK_CONTRACT_REQUIREMENTS} requirements.`,
      'limit_exceeded'
    )
  }
  const ids = new Set<string>()
  const normalized = requirements.map((requirement, index) => {
    const label = `acceptance[${index}]`
    const id = requireString(requirement?.id, `${label}.id`, MAX_IDENTITY_BYTES)
    if (ids.has(id)) {
      throw new TaskContractError(
        `acceptance requirement ID is duplicated: ${id}.`,
        'invalid_input'
      )
    }
    ids.add(id)

    if (requirement.kind === 'required_sections') {
      if (requirement.level !== 2 || !Array.isArray(requirement.sections)) {
        throw new TaskContractError(`${label} is invalid.`, 'invalid_input')
      }
      const seenSections = new Set<string>()
      const sections = requirement.sections.map((section, sectionIndex) => {
        const normalizedSection = requireString(
          section,
          `${label}.sections[${sectionIndex}]`,
          MAX_SECTION_NAME_BYTES
        )
        const identity = normalizedSection.toLowerCase()
        if (seenSections.has(identity)) {
          throw new TaskContractError(
            `${label} contains a duplicate section: ${normalizedSection}.`,
            'invalid_input'
          )
        }
        seenSections.add(identity)
        return normalizedSection
      })
      if (sections.length === 0 || sections.length > MAX_TASK_CONTRACT_REQUIREMENTS) {
        throw new TaskContractError(`${label}.sections has an invalid size.`, 'invalid_input')
      }
      sections.sort(compareCodePoints)
      return { id, kind: 'required_sections' as const, level: 2 as const, sections }
    }

    if (requirement.kind === 'result_schema') {
      return {
        id,
        kind: 'result_schema' as const,
        section: requireString(requirement.section, `${label}.section`, MAX_SECTION_NAME_BYTES),
        schema: normalizeJsonValue(requirement.schema, `${label}.schema`)
      }
    }
    throw new TaskContractError(`${label}.kind is invalid.`, 'invalid_input')
  })
  return normalized.sort((left, right) => compareCodePoints(left.id, right.id))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function buildTaskContractDraft(
  input: BuildTaskContractInput
): Omit<DeepChatTaskContract, 'contractHash'> {
  const maxSubagentDepth = requireNonNegativeSafeInteger(
    input.maxSubagentDepth ?? 0,
    'maxSubagentDepth'
  )
  if (maxSubagentDepth > MAX_SUBAGENT_DEPTH) {
    throw new TaskContractError(
      `maxSubagentDepth exceeds the V1 limit of ${MAX_SUBAGENT_DEPTH}.`,
      'limit_exceeded'
    )
  }
  const maxToolEffect = input.maxToolEffect ?? 'write'
  if (maxToolEffect !== 'read' && maxToolEffect !== 'write') {
    throw new TaskContractError('maxToolEffect is invalid.', 'invalid_input')
  }
  const creationReason = input.creationReason ?? 'delegation_created'
  if (creationReason !== 'delegation_created' && creationReason !== 'legacy_recovery') {
    throw new TaskContractError('creationReason is invalid.', 'invalid_input')
  }

  return {
    schemaVersion: DEEPCHAT_TASK_CONTRACT_SCHEMA_VERSION,
    hashVersion: DEEPCHAT_TASK_CONTRACT_HASH_VERSION,
    taskSchema: {
      input: { kind: 'text', maxBytes: MAX_TASK_INPUT_BYTES },
      output: { kind: 'markdown' }
    },
    taskConfig: {
      completionMode: 'single_response',
      retryMode: 'parent_follow_up',
      creationReason,
      predecessorEvaluationRef: normalizeEvaluationRef(input.predecessorEvaluationRef ?? null)
    },
    taskDescription: {
      delegationId: requireString(input.delegationId, 'delegationId', MAX_IDENTITY_BYTES, 256),
      turnId: requireString(input.turnId, 'turnId', MAX_IDENTITY_BYTES, 256),
      turnSeq: requirePositiveSafeInteger(input.turnSeq, 'turnSeq'),
      turnKind: input.turnKind,
      parentSessionId: requireString(
        input.parentSessionId,
        'parentSessionId',
        MAX_IDENTITY_BYTES,
        256
      ),
      slotId: requireString(input.slotId, 'slotId', MAX_IDENTITY_BYTES, 256),
      targetAgentId: requireString(input.targetAgentId, 'targetAgentId', MAX_IDENTITY_BYTES, 256),
      title: requireString(input.title, 'title', MAX_TITLE_BYTES, 160),
      prompt: requireString(input.prompt, 'prompt', MAX_PROMPT_BYTES)
    },
    taskHarness: {
      acceptance: normalizeAcceptance(input.acceptance),
      ceilings: {
        maxToolEffect,
        workspace: normalizeWorkspace(input.workspace),
        maxSubagentDepth
      }
    }
  }
}

export function buildTaskContract(input: BuildTaskContractInput): DeepChatTaskContract {
  if (input.turnKind !== 'initial' && input.turnKind !== 'follow_up') {
    throw new TaskContractError('turnKind is invalid.', 'invalid_input')
  }
  const draft = buildTaskContractDraft(input)
  const contract: DeepChatTaskContract = {
    ...draft,
    contractHash: hashJsonData(draft)
  }
  if (utf8Length(canonicalJsonStringifyData(contract)) > MAX_TASK_CONTRACT_BYTES) {
    throw new TaskContractError(
      `TaskContract exceeds ${MAX_TASK_CONTRACT_BYTES} UTF-8 bytes.`,
      'limit_exceeded'
    )
  }
  return deepFreeze(contract)
}

export function isDeepChatTaskContract(value: unknown): value is DeepChatTaskContract {
  if (
    !hasExactKeys(value, TASK_CONTRACT_KEYS) ||
    value.schemaVersion !== DEEPCHAT_TASK_CONTRACT_SCHEMA_VERSION ||
    value.hashVersion !== DEEPCHAT_TASK_CONTRACT_HASH_VERSION ||
    typeof value.contractHash !== 'string' ||
    !SHA_256_PATTERN.test(value.contractHash)
  ) {
    return false
  }
  try {
    const contract = value as unknown as DeepChatTaskContract
    const normalized = buildTaskContract({
      ...contract.taskDescription,
      workspace: contract.taskHarness.ceilings.workspace,
      acceptance: contract.taskHarness.acceptance,
      creationReason: contract.taskConfig.creationReason,
      predecessorEvaluationRef: contract.taskConfig.predecessorEvaluationRef,
      maxToolEffect: contract.taskHarness.ceilings.maxToolEffect,
      maxSubagentDepth: contract.taskHarness.ceilings.maxSubagentDepth
    })
    return canonicalJsonStringifyData(normalized) === canonicalJsonStringifyData(contract)
  } catch {
    return false
  }
}

export function restoreTaskContract(value: unknown): DeepChatTaskContract | null {
  return isDeepChatTaskContract(value) ? deepFreeze(value) : null
}

export function serializeTaskContract(contract: DeepChatTaskContract): string {
  if (!isDeepChatTaskContract(contract)) {
    throw new TaskContractError('TaskContract is not canonical.', 'invalid_input')
  }
  return canonicalJsonStringifyData(contract)
}

export function serializeTaskContractRef(ref: DeepChatTaskContractRef): string {
  if (!isDeepChatTaskContractRef(ref)) {
    throw new TaskContractError('TaskContractRef is invalid.', 'invalid_input')
  }
  return canonicalJsonStringifyData(ref)
}

export function isDeepChatTaskContractRef(value: unknown): value is DeepChatTaskContractRef {
  if (!hasExactKeys(value, TASK_CONTRACT_REF_KEYS) || value.schemaVersion !== 1) return false
  try {
    return (
      requireString(value.sessionId, 'TaskContractRef.sessionId', MAX_IDENTITY_BYTES, 256) ===
        value.sessionId &&
      typeof value.tapeIdentity === 'string' &&
      SHA_256_PATTERN.test(value.tapeIdentity) &&
      typeof value.contractHash === 'string' &&
      SHA_256_PATTERN.test(value.contractHash) &&
      requirePositiveSafeInteger(value.entryId, 'TaskContractRef.entryId') === value.entryId
    )
  } catch {
    return false
  }
}

export function restoreTaskContractRef(value: unknown): DeepChatTaskContractRef | null {
  return isDeepChatTaskContractRef(value) ? deepFreeze(value) : null
}
