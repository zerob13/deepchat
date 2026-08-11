import type { DeepChatTapeSkillContext } from '@shared/types/tape-view-manifest'
import { isSkillSourceType } from '@shared/types/skillManagement'

const HASH = /^[a-f0-9]{64}$/
const MAX_ID_BYTES = 1024
const MAX_SOURCE_REFS = 64

function id(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
  )
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function validateSchema6SkillContexts(value: unknown): DeepChatTapeSkillContext[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new TypeError('Schema-6 Skill contexts must contain between 1 and 64 entries.')
  }
  const identities = new Set<string>()
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new TypeError('Invalid Skill context.')
    const context = item as unknown as DeepChatTapeSkillContext
    const ref = context.authoritativeRef
    const contextKeys = [
      'activationScope',
      'agentId',
      'authoritativeRef',
      'deduplicationSource',
      'projectedContentHash',
      'projectionVersion',
      'providerRole',
      'skillName',
      'sourceEntryIds',
      'sourceId',
      'sourceType'
    ]
    if (
      Object.keys(item).sort().join('\0') !== contextKeys.sort().join('\0') ||
      !id(context.agentId) ||
      !isSkillSourceType(context.sourceType) ||
      !id(context.sourceId) ||
      !id(context.skillName) ||
      !ref ||
      !positive(ref.entryId) ||
      typeof context.projectedContentHash !== 'string' ||
      !HASH.test(context.projectedContentHash) ||
      !positive(context.projectionVersion) ||
      !Array.isArray(context.sourceEntryIds) ||
      context.sourceEntryIds.length > MAX_SOURCE_REFS ||
      !context.sourceEntryIds.every(positive) ||
      new Set(context.sourceEntryIds).size !== context.sourceEntryIds.length
    )
      throw new TypeError('Invalid Skill context identity, hash, or source refs.')
    const identity = [
      context.agentId,
      context.sourceType,
      context.sourceId,
      context.skillName
    ].join('\0')
    if (identities.has(identity)) throw new TypeError('Duplicate canonical Skill context identity.')
    identities.add(identity)
    if (context.activationScope === 'runtime_view') {
      const refKeys = ['contentHash', 'entryId', 'kind']
      if (
        Object.keys(ref).sort().join('\0') !== refKeys.sort().join('\0') ||
        context.providerRole !== 'tool' ||
        ref.kind !== 'tool_result' ||
        typeof ref.contentHash !== 'string' ||
        !HASH.test(ref.contentHash) ||
        context.projectedContentHash !== ref.contentHash ||
        context.deduplicationSource !== 'runtime_view'
      )
        throw new TypeError('Invalid runtime-view Skill context.')
    } else if (context.activationScope === 'message' || context.activationScope === 'session') {
      const expectedRole = context.activationScope === 'message' ? 'user' : 'system'
      const refKeys = [
        'agentId',
        'effectiveContentHash',
        'entryId',
        'kind',
        'skillName',
        'sourceId',
        'sourceType',
        'tapeIncarnationId'
      ]
      if (
        Object.keys(ref).sort().join('\0') !== refKeys.sort().join('\0') ||
        context.providerRole !== expectedRole ||
        ref.kind !== 'materialization' ||
        context.deduplicationSource !== context.activationScope ||
        !id(ref.tapeIncarnationId) ||
        !id(ref.agentId) ||
        !isSkillSourceType(ref.sourceType) ||
        !id(ref.sourceId) ||
        !id(ref.skillName) ||
        !HASH.test(ref.effectiveContentHash) ||
        context.projectedContentHash !== ref.effectiveContentHash ||
        ref.agentId !== context.agentId ||
        ref.sourceType !== context.sourceType ||
        ref.sourceId !== context.sourceId ||
        ref.skillName !== context.skillName
      ) {
        throw new TypeError('Invalid materialized Skill context.')
      }
    } else throw new TypeError('Invalid Skill activation scope.')
    return context
  })
}
