import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import Ajv, { type AnySchema, type ErrorObject } from 'ajv'
import safeRegex from 'safe-regex2'
import {
  DEEPCHAT_EVALUATION_REF_SCHEMA_VERSION,
  DEEPCHAT_TASK_EVALUATION_HASH_VERSION,
  DEEPCHAT_TASK_EVALUATION_SCHEMA_VERSION,
  DEEPCHAT_TASK_EVALUATOR_VERSION,
  DeepChatTaskEvaluationProjectionSchema,
  MAX_TASK_EVALUATION_BYTES,
  MAX_TASK_EVALUATION_CANDIDATE_BYTES,
  MAX_TASK_EVALUATION_PARENT_EVIDENCE,
  MAX_TASK_EVALUATION_RECORDS,
  type DeepChatEvaluationRef,
  type DeepChatTaskContract,
  type DeepChatTaskEvaluation,
  type DeepChatTaskEvaluationExecutionStatus,
  type DeepChatTaskEvaluationReasonCode,
  type DeepChatTaskEvaluationRecord,
  type DeepChatTaskEvaluationSummary
} from '@shared/types/task-contract'
import type { JsonValue } from '@shared/contracts/json'
import {
  indexMarkdownLevelTwoSections,
  removeEnclosingMarkdownFence
} from '@shared/orchestration/liveDelegationMarkdown'
import { canonicalJsonStringifyData, hashJsonData } from './canonicalJson'
import { isDeepChatTaskContract } from './taskContract'

const MAX_CANDIDATE_JSON_DEPTH = 64
const MAX_CANDIDATE_JSON_NODES = 4_096
const MAX_EVIDENCE_PATH_CHARACTERS = 1_024
const MAX_EVIDENCE_KEYWORD_CHARACTERS = 128
const SHA_256_PATTERN = /^[0-9a-f]{64}$/u
const SUCCESS_REASON_CODES = new Set<DeepChatTaskEvaluationReasonCode>([
  'required_sections_present',
  'result_schema_valid'
])
const SINGLE_SCHEMA_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties'
] as const
const ARRAY_SCHEMA_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const
const MAP_SCHEMA_KEYWORDS = [
  '$defs',
  'definitions',
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties'
] as const

type ParsedResultSection =
  | { state: 'missing' }
  | { state: 'invalid' }
  | { state: 'too_complex' }
  | { state: 'available'; value: unknown }

type CachedSchemaEvaluation = Pick<
  DeepChatTaskEvaluationRecord,
  'outcome' | 'code' | 'instancePath' | 'keyword'
>

export interface BuildTaskEvaluationInput {
  contract: DeepChatTaskContract
  executionStatus: DeepChatTaskEvaluationExecutionStatus
  candidateResult: string | null
}

export class TaskEvaluationError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'limit_exceeded',
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'TaskEvaluationError'
  }
}

export function buildTaskEvaluation(input: BuildTaskEvaluationInput): DeepChatTaskEvaluation {
  if (!isDeepChatTaskContract(input.contract)) {
    throw new TaskEvaluationError(
      'Task evaluation requires a canonical TaskContract.',
      'invalid_input'
    )
  }
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(input.executionStatus)) {
    throw new TaskEvaluationError('Task evaluation execution status is invalid.', 'invalid_input')
  }
  if (input.candidateResult !== null && typeof input.candidateResult !== 'string') {
    throw new TaskEvaluationError('Task evaluation candidate is invalid.', 'invalid_input')
  }

  const candidateResult = input.candidateResult?.trim() || null
  const candidate = candidateResult
    ? {
        kind: 'answer' as const,
        sha256: createHash('sha256').update(candidateResult, 'utf8').digest('hex'),
        utf8Bytes: Buffer.byteLength(candidateResult, 'utf8')
      }
    : ({ kind: 'absent' } as const)
  let records: DeepChatTaskEvaluationRecord[]

  if (input.executionStatus === 'cancelled' || input.executionStatus === 'interrupted') {
    records = [
      evaluationRecord({
        outcome: 'indeterminate',
        code:
          input.executionStatus === 'cancelled' ? 'execution_cancelled' : 'execution_interrupted'
      })
    ]
  } else if (!candidateResult) {
    records = [evaluationRecord({ outcome: 'indeterminate', code: 'candidate_missing' })]
  } else if (
    candidate.kind === 'answer' &&
    candidate.utf8Bytes > MAX_TASK_EVALUATION_CANDIDATE_BYTES
  ) {
    records = [evaluationRecord({ outcome: 'indeterminate', code: 'candidate_too_large' })]
  } else {
    records = evaluateRequirements(input.contract, candidateResult)
  }

  const verdict = records.some((record) => record.outcome === 'failed')
    ? 'failed'
    : records.some((record) => record.outcome === 'indeterminate')
      ? 'indeterminate'
      : 'passed'
  const reasonCodes = [
    ...new Set(records.filter((record) => record.outcome !== 'passed').map((record) => record.code))
  ].sort(compareCodePoints)

  return finalizeEvaluation({
    schemaVersion: DEEPCHAT_TASK_EVALUATION_SCHEMA_VERSION,
    hashVersion: DEEPCHAT_TASK_EVALUATION_HASH_VERSION,
    evaluatorVersion: DEEPCHAT_TASK_EVALUATOR_VERSION,
    turnId: input.contract.taskDescription.turnId,
    taskContractHash: input.contract.contractHash,
    candidate,
    executionStatus: input.executionStatus,
    verdict,
    disposition: verdict === 'passed' ? 'accepted' : 'parked',
    reasonCodes,
    records,
    omittedRecordCount: 0
  })
}

export function restoreTaskEvaluation(value: unknown): DeepChatTaskEvaluation | null {
  const parsed = DeepChatTaskEvaluationProjectionSchema.safeParse(value)
  if (!parsed.success) return null
  const evaluation = parsed.data
  if (
    Buffer.byteLength(canonicalJsonStringifyData(evaluation), 'utf8') > MAX_TASK_EVALUATION_BYTES
  ) {
    return null
  }
  const { evaluationHash, ...draft } = evaluation
  if (hashJsonData(draft) !== evaluationHash) return null
  if (!isCanonicalEvaluation(evaluation)) return null
  return deepFreeze(evaluation)
}

export function isDeepChatTaskEvaluation(value: unknown): value is DeepChatTaskEvaluation {
  return restoreTaskEvaluation(value) !== null
}

export function serializeTaskEvaluation(evaluation: DeepChatTaskEvaluation): string {
  const restored = restoreTaskEvaluation(evaluation)
  if (!restored) throw new TaskEvaluationError('Task evaluation is invalid.', 'invalid_input')
  return canonicalJsonStringifyData(restored)
}

export function isDeepChatEvaluationRef(value: unknown): value is DeepChatEvaluationRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return (
    Object.keys(ref).length === 5 &&
    ref.schemaVersion === DEEPCHAT_EVALUATION_REF_SCHEMA_VERSION &&
    typeof ref.sessionId === 'string' &&
    ref.sessionId.trim() === ref.sessionId &&
    ref.sessionId.length > 0 &&
    ref.sessionId.length <= 256 &&
    typeof ref.tapeIdentity === 'string' &&
    SHA_256_PATTERN.test(ref.tapeIdentity) &&
    Number.isSafeInteger(ref.entryId) &&
    (ref.entryId as number) > 0 &&
    typeof ref.evaluationHash === 'string' &&
    SHA_256_PATTERN.test(ref.evaluationHash)
  )
}

export function restoreEvaluationRef(value: unknown): DeepChatEvaluationRef | null {
  return isDeepChatEvaluationRef(value) ? Object.freeze({ ...value }) : null
}

export function serializeEvaluationRef(ref: DeepChatEvaluationRef): string {
  if (!isDeepChatEvaluationRef(ref)) {
    throw new TaskEvaluationError('Task evaluation reference is invalid.', 'invalid_input')
  }
  return canonicalJsonStringifyData(ref)
}

export function projectTaskEvaluationSummary(
  evaluation: DeepChatTaskEvaluation,
  evaluationRef: DeepChatEvaluationRef,
  maxEvidenceRecords = MAX_TASK_EVALUATION_PARENT_EVIDENCE
): DeepChatTaskEvaluationSummary {
  const canonicalEvaluation = restoreTaskEvaluation(evaluation)
  const canonicalRef = restoreEvaluationRef(evaluationRef)
  if (
    !canonicalEvaluation ||
    !canonicalRef ||
    canonicalRef.evaluationHash !== canonicalEvaluation.evaluationHash
  ) {
    throw new TaskEvaluationError('Task evaluation summary inputs conflict.', 'invalid_input')
  }
  if (!Number.isSafeInteger(maxEvidenceRecords) || maxEvidenceRecords < 0) {
    throw new TaskEvaluationError('Task evaluation evidence limit is invalid.', 'invalid_input')
  }
  const evidenceLimit = Math.min(maxEvidenceRecords, MAX_TASK_EVALUATION_PARENT_EVIDENCE)
  const relevant = canonicalEvaluation.records.filter((record) => record.outcome !== 'passed')
  const evidence = relevant.slice(0, evidenceLimit)
  return deepFreeze({
    verdict: canonicalEvaluation.verdict,
    disposition: canonicalEvaluation.disposition,
    reasonCodes: [...canonicalEvaluation.reasonCodes],
    candidate: canonicalEvaluation.candidate,
    evidence,
    evaluationRef: canonicalRef,
    omittedEvidenceCount:
      canonicalEvaluation.omittedRecordCount + Math.max(0, relevant.length - evidence.length)
  })
}

function evaluateRequirements(
  contract: DeepChatTaskContract,
  candidateResult: string
): DeepChatTaskEvaluationRecord[] {
  const sections = indexMarkdownLevelTwoSections(candidateResult)
  const parsedSections = new Map<string, ParsedResultSection>()
  const schemaEvaluations = new Map<string, CachedSchemaEvaluation>()
  const ajv = new Ajv({
    allErrors: false,
    strict: true,
    validateFormats: false,
    messages: false
  })

  return contract.taskHarness.acceptance.map((requirement) => {
    if (requirement.kind === 'required_sections') {
      const missing = requirement.sections.filter(
        (section) => !(sections.get(section.toLowerCase())?.body.trim() ?? '')
      )
      return evaluationRecord({
        requirementId: requirement.id,
        requirementKind: requirement.kind,
        outcome: missing.length === 0 ? 'passed' : 'failed',
        code: missing.length === 0 ? 'required_sections_present' : 'required_sections_missing',
        section: missing[0] ?? null,
        additionalEvidenceCount: Math.max(0, missing.length - 1)
      })
    }

    const sectionIdentity = requirement.section.toLowerCase()
    let parsedSection = parsedSections.get(sectionIdentity)
    if (!parsedSection) {
      const section = sections.get(sectionIdentity)
      if (!section?.body.trim()) {
        parsedSection = { state: 'missing' }
      } else {
        try {
          const value = JSON.parse(removeEnclosingMarkdownFence(section.body)) as unknown
          parsedSection = isBoundedCandidateJson(value)
            ? { state: 'available', value }
            : { state: 'too_complex' }
        } catch {
          parsedSection = { state: 'invalid' }
        }
      }
      parsedSections.set(sectionIdentity, parsedSection)
    }

    if (parsedSection.state === 'missing') {
      return evaluationRecord({
        requirementId: requirement.id,
        requirementKind: requirement.kind,
        outcome: 'failed',
        code: 'result_section_missing',
        section: requirement.section
      })
    }
    if (parsedSection.state === 'invalid') {
      return evaluationRecord({
        requirementId: requirement.id,
        requirementKind: requirement.kind,
        outcome: 'failed',
        code: 'result_json_invalid',
        section: requirement.section
      })
    }
    if (parsedSection.state === 'too_complex') {
      return evaluationRecord({
        requirementId: requirement.id,
        requirementKind: requirement.kind,
        outcome: 'indeterminate',
        code: 'candidate_too_complex',
        section: requirement.section
      })
    }

    const schemaCacheKey = `${sectionIdentity}\0${hashJsonData(requirement.schema)}`
    let schemaEvaluation = schemaEvaluations.get(schemaCacheKey)
    if (!schemaEvaluation) {
      try {
        assertSafeSchemaRegexes(requirement.schema)
        const validate = ajv.compile(requirement.schema as AnySchema)
        schemaEvaluation = validate(parsedSection.value)
          ? {
              outcome: 'passed',
              code: 'result_schema_valid',
              instancePath: null,
              keyword: null
            }
          : schemaMismatchEvidence(validate.errors?.[0])
      } catch {
        schemaEvaluation = {
          outcome: 'indeterminate',
          code: 'evaluator_error',
          instancePath: null,
          keyword: null
        }
      }
      schemaEvaluations.set(schemaCacheKey, schemaEvaluation)
    }
    return evaluationRecord({
      requirementId: requirement.id,
      requirementKind: requirement.kind,
      section: requirement.section,
      ...schemaEvaluation
    })
  })
}

function schemaMismatchEvidence(error: ErrorObject | null | undefined): CachedSchemaEvaluation {
  return {
    outcome: 'failed',
    code: 'result_schema_mismatch',
    instancePath: normalizeEvidenceText(error?.instancePath, MAX_EVIDENCE_PATH_CHARACTERS),
    keyword: normalizeEvidenceText(error?.keyword, MAX_EVIDENCE_KEYWORD_CHARACTERS)
  }
}

function evaluationRecord(
  input: Partial<DeepChatTaskEvaluationRecord> &
    Pick<DeepChatTaskEvaluationRecord, 'outcome' | 'code'>
): DeepChatTaskEvaluationRecord {
  return {
    requirementId: input.requirementId ?? null,
    requirementKind: input.requirementKind ?? null,
    outcome: input.outcome,
    code: input.code,
    section: input.section ?? null,
    instancePath: input.instancePath ?? null,
    keyword: input.keyword ?? null,
    additionalEvidenceCount: input.additionalEvidenceCount ?? 0
  }
}

function finalizeEvaluation(
  input: Omit<DeepChatTaskEvaluation, 'evaluationHash'>
): DeepChatTaskEvaluation {
  const records = [...input.records].slice(0, MAX_TASK_EVALUATION_RECORDS)
  let omittedRecordCount =
    input.omittedRecordCount + Math.max(0, input.records.length - records.length)

  while (true) {
    const draft: Omit<DeepChatTaskEvaluation, 'evaluationHash'> = {
      ...input,
      records,
      omittedRecordCount
    }
    const evaluation: DeepChatTaskEvaluation = {
      ...draft,
      evaluationHash: hashJsonData(draft)
    }
    const serialized = canonicalJsonStringifyData(evaluation)
    if (Buffer.byteLength(serialized, 'utf8') <= MAX_TASK_EVALUATION_BYTES) {
      const restored = restoreTaskEvaluation(evaluation)
      if (!restored) {
        throw new TaskEvaluationError('Task evaluation is not canonical.', 'invalid_input')
      }
      return restored
    }
    if (records.length === 0) {
      throw new TaskEvaluationError(
        `Task evaluation exceeds ${MAX_TASK_EVALUATION_BYTES} UTF-8 bytes.`,
        'limit_exceeded'
      )
    }
    records.pop()
    omittedRecordCount += 1
  }
}

function isCanonicalEvaluation(evaluation: DeepChatTaskEvaluation): boolean {
  if ((evaluation.verdict === 'passed') !== (evaluation.disposition === 'accepted')) return false
  if (evaluation.reasonCodes.some((code) => SUCCESS_REASON_CODES.has(code))) return false
  if (
    canonicalJsonStringifyData(evaluation.reasonCodes) !==
    canonicalJsonStringifyData([...new Set(evaluation.reasonCodes)].sort(compareCodePoints))
  ) {
    return false
  }
  const recordedReasonCodes = [
    ...new Set(
      evaluation.records
        .filter((record) => record.outcome !== 'passed')
        .map((record) => record.code)
    )
  ].sort(compareCodePoints)
  if (
    evaluation.omittedRecordCount === 0 &&
    canonicalJsonStringifyData(evaluation.reasonCodes) !==
      canonicalJsonStringifyData(recordedReasonCodes)
  ) {
    return false
  }
  const reasonOutcomes = evaluation.reasonCodes.map(reasonCodeOutcome)
  const expectedVerdict = reasonOutcomes.includes('failed')
    ? 'failed'
    : reasonOutcomes.includes('indeterminate')
      ? 'indeterminate'
      : 'passed'
  if (evaluation.verdict !== expectedVerdict) return false
  return evaluation.records.every(
    (record) =>
      recordMatchesReasonCode(record) &&
      (record.outcome === 'passed' || evaluation.reasonCodes.includes(record.code))
  )
}

function recordMatchesReasonCode(record: DeepChatTaskEvaluationRecord): boolean {
  const expectedOutcome = reasonCodeOutcome(record.code)
  if (record.outcome !== expectedOutcome) return false
  const requirementCode =
    record.code.startsWith('required_sections_') ||
    record.code.startsWith('result_') ||
    record.code === 'candidate_too_complex' ||
    record.code === 'evaluator_error'
  return requirementCode
    ? record.requirementId !== null && record.requirementKind !== null
    : record.requirementId === null && record.requirementKind === null
}

function reasonCodeOutcome(
  code: DeepChatTaskEvaluationReasonCode
): DeepChatTaskEvaluationRecord['outcome'] {
  if (SUCCESS_REASON_CODES.has(code)) return 'passed'
  if (
    code === 'required_sections_missing' ||
    code === 'result_section_missing' ||
    code === 'result_json_invalid' ||
    code === 'result_schema_mismatch'
  ) {
    return 'failed'
  }
  return 'indeterminate'
}

function isBoundedCandidateJson(value: unknown): boolean {
  const state = { nodes: 0 }
  const visit = (candidate: unknown, depth: number): boolean => {
    state.nodes += 1
    if (depth > MAX_CANDIDATE_JSON_DEPTH || state.nodes > MAX_CANDIDATE_JSON_NODES) return false
    if (candidate === null || typeof candidate !== 'object') return true
    if (Array.isArray(candidate)) return candidate.every((entry) => visit(entry, depth + 1))
    return Object.values(candidate as Record<string, unknown>).every((entry) =>
      visit(entry, depth + 1)
    )
  }
  return visit(value, 0)
}

function assertSafeSchemaRegexes(value: JsonValue): void {
  if (typeof value === 'boolean' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return
  }
  const schema = value as Record<string, JsonValue>
  if (typeof schema.pattern === 'string' && !safeRegex(schema.pattern)) {
    throw new TaskEvaluationError('Result schema contains an unsafe pattern.', 'invalid_input')
  }
  if (
    schema.patternProperties &&
    typeof schema.patternProperties === 'object' &&
    !Array.isArray(schema.patternProperties)
  ) {
    for (const pattern of Object.keys(schema.patternProperties)) {
      if (!safeRegex(pattern)) {
        throw new TaskEvaluationError(
          'Result schema contains an unsafe pattern property.',
          'invalid_input'
        )
      }
    }
  }

  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    visitNestedSchema(schema[keyword])
  }
  for (const keyword of ARRAY_SCHEMA_KEYWORDS) {
    const nested = schema[keyword]
    if (Array.isArray(nested)) {
      for (const child of nested) visitNestedSchema(child)
    }
  }
  for (const keyword of MAP_SCHEMA_KEYWORDS) {
    const nested = schema[keyword]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
    for (const child of Object.values(nested)) visitNestedSchema(child)
  }
}

function visitNestedSchema(value: JsonValue | undefined): void {
  if (Array.isArray(value)) {
    for (const child of value) visitNestedSchema(child)
    return
  }
  if (typeof value === 'boolean' || (value && typeof value === 'object')) {
    assertSafeSchemaRegexes(value)
  }
}

function normalizeEvidenceText(value: string | undefined, maxCharacters: number): string | null {
  if (!value) return null
  const sanitized = value.replaceAll('\0', '\uFFFD')
  return sanitized.length <= maxCharacters ? sanitized : sanitized.slice(0, maxCharacters)
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}
