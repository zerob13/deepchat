import { createHash } from 'crypto'
import { canonicalJsonStringifyData, hashJsonData } from './canonicalJson'
import type { DeepChatTapeSkillMaterializationRef } from '@shared/types/tape-view-manifest'
import { isSkillSourceType, type SkillSourceType } from '@shared/types/skillManagement'
import { SKILL_EFFECTIVE_CONTENT_MAX_BYTES } from '@shared/types/skill'
import type { DeepChatTapeEntryRow } from './entry'

export const SKILL_MATERIALIZATION_NAME = 'skill/materialized' as const
export const SKILL_MATERIALIZATION_SCHEMA_VERSION = 1 as const
export const MAX_SKILL_MATERIALIZATION_BODY_BYTES = SKILL_EFFECTIVE_CONTENT_MAX_BYTES
export const MAX_SKILL_MATERIALIZATION_BATCH_COUNT = 64
export const MAX_SKILL_MATERIALIZATION_BATCH_BYTES = 2 * 1024 * 1024

const SHA256 = /^[a-f0-9]{64}$/
const MAX_IDENTITY_BYTES = 1024

export interface TapeSkillIdentity {
  agentId: string
  sourceType: SkillSourceType
  sourceId: string
  skillName: string
}

export interface TapeSkillMaterializationPayload extends TapeSkillIdentity {
  schemaVersion: 1
  tapeIncarnationId: string
  effectiveContent: string
  effectiveContentHash: string
  builderVersion: string
  renderedManifestHash: string
  scriptInventoryHash: string
  byteCount: number
}

export interface TapeSkillMaterializationInput extends TapeSkillIdentity {
  sessionId: string
  expectedTapeIncarnationId: string
  effectiveContent: string
  builderVersion: string
  renderedManifestHash: string
  scriptInventoryHash: string
}

export interface TapeSkillMaterializationReceipt {
  sessionId: string
  entryId: number
  tapeIncarnationId: string
  provenanceKey: string
  payloadHash: string
  payload: TapeSkillMaterializationPayload
}

export type TapeSkillMaterializationRef = DeepChatTapeSkillMaterializationRef & {
  sessionId: string
}

function parseObject(json: string, field: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(json) as unknown
  } catch {
    throw new TypeError(`${field} must contain valid JSON.`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must contain a JSON object.`)
  }
  return value as Record<string, unknown>
}

function requireIdentity(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > MAX_IDENTITY_BYTES
  ) {
    throw new TypeError(`${field} must be a non-empty UTF-8 string of at most 1024 bytes.`)
  }
  return value
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 hash.`)
  }
  return value
}

export function hashSkillEffectiveContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function createTapeSkillMaterializationPayload(
  input: TapeSkillMaterializationInput
): TapeSkillMaterializationPayload {
  const effectiveContent = input.effectiveContent
  if (typeof effectiveContent !== 'string')
    throw new TypeError('effectiveContent must be a string.')
  const byteCount = Buffer.byteLength(effectiveContent, 'utf8')
  if (byteCount > MAX_SKILL_MATERIALIZATION_BODY_BYTES) {
    throw new RangeError('Skill materialization body exceeds 512 KiB.')
  }
  return validateTapeSkillMaterializationPayload({
    schemaVersion: SKILL_MATERIALIZATION_SCHEMA_VERSION,
    tapeIncarnationId: input.expectedTapeIncarnationId,
    agentId: input.agentId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    skillName: input.skillName,
    effectiveContent,
    effectiveContentHash: hashSkillEffectiveContent(effectiveContent),
    builderVersion: input.builderVersion,
    renderedManifestHash: input.renderedManifestHash,
    scriptInventoryHash: input.scriptInventoryHash,
    byteCount
  })
}

export function validateTapeSkillMaterializationPayload(
  value: unknown
): TapeSkillMaterializationPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Skill materialization payload must be an object.')
  }
  const payload = value as Record<string, unknown>
  const expectedKeys = [
    'agentId',
    'builderVersion',
    'byteCount',
    'effectiveContent',
    'effectiveContentHash',
    'renderedManifestHash',
    'schemaVersion',
    'scriptInventoryHash',
    'skillName',
    'sourceType',
    'sourceId',
    'tapeIncarnationId'
  ].sort()
  if (Object.keys(payload).sort().join('\0') !== expectedKeys.join('\0')) {
    throw new TypeError('Skill materialization payload has unknown or missing fields.')
  }
  if (payload.schemaVersion !== 1) throw new TypeError('Unsupported Skill materialization schema.')
  const effectiveContent =
    typeof payload.effectiveContent === 'string' ? payload.effectiveContent : null
  if (effectiveContent === null) throw new TypeError('effectiveContent must be a string.')
  const byteCount = Buffer.byteLength(effectiveContent, 'utf8')
  if (byteCount > MAX_SKILL_MATERIALIZATION_BODY_BYTES || payload.byteCount !== byteCount) {
    throw new RangeError('Skill materialization byte count is invalid.')
  }
  if (payload.effectiveContentHash !== hashSkillEffectiveContent(effectiveContent)) {
    throw new TypeError('Skill materialization content hash is invalid.')
  }
  const sourceType = requireIdentity(payload.sourceType, 'sourceType')
  if (!isSkillSourceType(sourceType)) {
    throw new TypeError('sourceType is not a supported Skill source type.')
  }
  return {
    schemaVersion: 1,
    tapeIncarnationId: requireIdentity(payload.tapeIncarnationId, 'tapeIncarnationId'),
    agentId: requireIdentity(payload.agentId, 'agentId'),
    sourceType,
    sourceId: requireIdentity(payload.sourceId, 'sourceId'),
    skillName: requireIdentity(payload.skillName, 'skillName'),
    effectiveContent,
    effectiveContentHash: requireHash(payload.effectiveContentHash, 'effectiveContentHash'),
    builderVersion: requireIdentity(payload.builderVersion, 'builderVersion'),
    renderedManifestHash: requireHash(payload.renderedManifestHash, 'renderedManifestHash'),
    scriptInventoryHash: requireHash(payload.scriptInventoryHash, 'scriptInventoryHash'),
    byteCount
  }
}

export function buildTapeSkillMaterializationProvenanceKey(
  sessionId: string,
  payload: TapeSkillMaterializationPayload
): string {
  requireIdentity(sessionId, 'sessionId')
  return `skill-materialized:${hashJsonData({ sessionId, payload })}`
}

export function canonicalSkillMaterializationPayload(
  payload: TapeSkillMaterializationPayload
): string {
  return canonicalJsonStringifyData(payload)
}

export function buildTapeSkillMaterializationPayloadHash(
  payload: TapeSkillMaterializationPayload
): string {
  return hashJsonData(payload)
}

export function validateTapeSkillMaterializationBatch(
  inputs: readonly TapeSkillMaterializationInput[]
): TapeSkillMaterializationPayload[] {
  if (inputs.length > MAX_SKILL_MATERIALIZATION_BATCH_COUNT) {
    throw new RangeError('Skill materialization batch exceeds 64 bodies.')
  }
  let bytes = 0
  return inputs.map((input) => {
    requireIdentity(input.sessionId, 'sessionId')
    const payload = createTapeSkillMaterializationPayload(input)
    bytes += payload.byteCount
    if (bytes > MAX_SKILL_MATERIALIZATION_BATCH_BYTES) {
      throw new RangeError('Skill materialization batch exceeds 2 MiB.')
    }
    return payload
  })
}

export function readTapeSkillMaterializationRow(
  row: DeepChatTapeEntryRow
): TapeSkillMaterializationReceipt {
  if (
    row.kind !== 'context' ||
    row.name !== SKILL_MATERIALIZATION_NAME ||
    row.source_type !== 'runtime_event' ||
    row.source_seq !== 0 ||
    !row.provenance_key
  ) {
    throw new Error('Stored Skill materialization identity is corrupt.')
  }

  const payload = validateTapeSkillMaterializationPayload(
    parseObject(row.payload_json, 'Skill materialization payload')
  )
  const provenanceKey = buildTapeSkillMaterializationProvenanceKey(row.session_id, payload)
  if (row.source_id !== payload.sourceId || row.provenance_key !== provenanceKey) {
    throw new Error('Stored Skill materialization provenance is corrupt.')
  }

  const payloadHash = hashJsonData(payload)
  const meta = parseObject(row.meta_json, 'Skill materialization metadata')
  if (
    Object.keys(meta).length !== 1 ||
    typeof meta.payloadHash !== 'string' ||
    meta.payloadHash !== payloadHash
  ) {
    throw new Error('Stored Skill materialization payload hash is corrupt.')
  }

  return {
    sessionId: row.session_id,
    entryId: row.entry_id,
    tapeIncarnationId: payload.tapeIncarnationId,
    provenanceKey,
    payloadHash,
    payload
  }
}

export function buildTapeSkillMaterializationRef(
  receipt: TapeSkillMaterializationReceipt
): TapeSkillMaterializationRef {
  return {
    sessionId: receipt.sessionId,
    kind: 'materialization',
    entryId: receipt.entryId,
    tapeIncarnationId: receipt.tapeIncarnationId,
    agentId: receipt.payload.agentId,
    sourceType: receipt.payload.sourceType,
    sourceId: receipt.payload.sourceId,
    skillName: receipt.payload.skillName,
    effectiveContentHash: receipt.payload.effectiveContentHash
  }
}

export function readTapeSkillMaterializationRef(
  row: DeepChatTapeEntryRow,
  ref: TapeSkillMaterializationRef
): TapeSkillMaterializationReceipt {
  if (
    ref.kind !== 'materialization' ||
    row.session_id !== ref.sessionId ||
    row.entry_id !== ref.entryId
  ) {
    throw new Error('Skill materialization reference does not match its Tape entry.')
  }
  const receipt = readTapeSkillMaterializationRow(row)
  const payload = receipt.payload
  if (
    payload.tapeIncarnationId !== ref.tapeIncarnationId ||
    payload.agentId !== ref.agentId ||
    payload.sourceType !== ref.sourceType ||
    payload.sourceId !== ref.sourceId ||
    payload.skillName !== ref.skillName ||
    payload.effectiveContentHash !== ref.effectiveContentHash
  ) {
    throw new Error('Skill materialization reference identity or content hash drifted.')
  }
  return receipt
}
