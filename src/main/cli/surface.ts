import type { RouteContract } from '@shared/contracts/contract'
import type { JsonValue } from '@shared/contracts/json'
import {
  AUDIO_TRANSCRIPTION_MAX_INPUT_BYTES,
  OCR_EXTRACTION_MAX_INPUT_BYTES,
  artifactsDeleteRoute,
  artifactsDescribeRoute,
  artifactsReadRoute,
  audioTranscribeArtifactRoute,
  audioTranscribeUploadRoute,
  cliCapabilitiesRoute,
  cliDoctorRoute,
  cliStatusRoute,
  cliVersionRoute,
  imagesGenerateRoute,
  modelsInvokeRoute,
  ocrClearCacheRoute,
  ocrExtractArtifactRoute,
  ocrExtractUploadRoute,
  ocrGetRuntimeStatusRoute,
  providersListPublicRoute,
  speechGenerateRoute,
  settingsGetPublicRoute,
  settingsUpdatePublicRoute,
  videosGenerateRoute,
  type CliCapability
} from '@shared/contracts/routes'
import {
  LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS,
  type LocalControlEffect,
  type LocalControlPrincipal,
  type LocalControlScope
} from '@shared/contracts/localControl'

export type LocalControlTransport = 'rpc' | 'stream' | 'upload' | 'download'
export type LocalControlApprovalMode = 'never' | 'policy'
export type CliSurfaceEffect =
  | LocalControlEffect
  | Readonly<{
      possible: readonly LocalControlEffect[]
      resolve(input: unknown): LocalControlEffect
    }>

export type CliRouteLimits = Readonly<{
  maxBodyBytes: number
  timeoutMs: number
}>

export type CliSurfaceEntry = Readonly<{
  contract: RouteContract
  effect: CliSurfaceEffect
  callers: readonly LocalControlPrincipal[]
  scopes: readonly LocalControlScope[]
  transport: LocalControlTransport
  approval: LocalControlApprovalMode
  auditProjection?: (input: unknown) => JsonValue
  approvalDisplay?: (input: unknown) => JsonValue
  agentInputAllowed?: (input: unknown) => boolean
  limits: CliRouteLimits
}>

const PREFERENCE_SETTING_KEYS = new Set([
  'fontSizeLevel',
  'fontFamily',
  'codeFontFamily',
  'artifactsEffectEnabled',
  'autoScrollEnabled',
  'notificationsEnabled',
  'copyWithCotEnabled'
])

const EXECUTION_SETTING_KEYS = new Set([
  'autoCompactionEnabled',
  'autoCompactionTriggerThreshold',
  'autoCompactionRetainRecentPairs',
  'ocrAutoExtractForNonVisionModels',
  'ocrBackend'
])

function settingChangeKeys(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const changes = (input as Record<string, unknown>).changes
  if (!Array.isArray(changes)) return []
  return changes.flatMap((change) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return []
    const key = (change as Record<string, unknown>).key
    return typeof key === 'string' ? [key] : []
  })
}

function settingChangesForDisplay(input: unknown): JsonValue {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const changes = (input as Record<string, unknown>).changes
  if (!Array.isArray(changes)) return []
  return changes.flatMap((change) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return []
    const { key, value } = change as Record<string, unknown>
    if (
      typeof key !== 'string' ||
      !(
        value === null ||
        typeof value === 'string' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        typeof value === 'boolean'
      )
    ) {
      return []
    }
    return [{ key, value }]
  })
}

function stringArrayField(input: unknown, field: string): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const value = (input as Record<string, unknown>)[field]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function listCliSurfaceEffects(entry: CliSurfaceEntry): readonly LocalControlEffect[] {
  return typeof entry.effect === 'string' ? [entry.effect] : entry.effect.possible
}

export function resolveCliSurfaceEffect(
  entry: CliSurfaceEntry,
  input: unknown
): LocalControlEffect {
  if (typeof entry.effect === 'string') return entry.effect
  const resolved = entry.effect.resolve(input)
  if (!entry.effect.possible.includes(resolved)) {
    throw new Error(`CLI surface effect resolver returned an undeclared effect: ${resolved}`)
  }
  return resolved
}

function selectAuditFields(input: unknown, fields: readonly string[]): Record<string, JsonValue> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const source = input as Record<string, unknown>
  const selected: Record<string, JsonValue> = {}
  for (const field of fields) {
    const value = source[field]
    if (
      value === null ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean'
    ) {
      selected[field] = value
    }
  }
  return selected
}

const DIAGNOSTIC_LIMITS = {
  maxBodyBytes: 16 * 1024,
  timeoutMs: 5_000
} as const satisfies CliRouteLimits

const diagnosticEntry = (contract: RouteContract): CliSurfaceEntry => ({
  contract,
  effect: 'read',
  callers: ['human', 'agent'],
  scopes: ['system:read'],
  transport: 'rpc',
  approval: 'never',
  limits: DIAGNOSTIC_LIMITS
})

const mediaEntry = (contract: RouteContract): CliSurfaceEntry => ({
  contract,
  effect: 'compute',
  callers: ['human', 'agent'],
  scopes: ['media:generate'],
  transport: 'stream',
  approval: 'never',
  auditProjection: (input) => selectAuditFields(input, ['providerId', 'modelId']),
  limits: {
    maxBodyBytes: 512 * 1024,
    timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS
  }
})

const CLI_SURFACE_V1_ENTRIES = [
  {
    contract: modelsInvokeRoute,
    effect: 'compute',
    callers: ['human', 'agent'],
    scopes: ['models:invoke'],
    transport: 'stream',
    approval: 'never',
    auditProjection: (input) => {
      const selected = selectAuditFields(input, [
        'providerId',
        'modelId',
        'temperature',
        'maxTokens'
      ])
      const messages =
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>).messages
          : undefined
      return { ...selected, messageCount: Array.isArray(messages) ? messages.length : 0 }
    },
    limits: { maxBodyBytes: 5 * 1024 * 1024, timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS }
  },
  mediaEntry(imagesGenerateRoute),
  mediaEntry(videosGenerateRoute),
  mediaEntry(speechGenerateRoute),
  {
    contract: audioTranscribeUploadRoute,
    effect: 'compute',
    callers: ['human'],
    scopes: ['audio:transcribe'],
    transport: 'upload',
    approval: 'never',
    auditProjection: (input) => selectAuditFields(input, ['providerId', 'modelId', 'mimeType']),
    limits: {
      maxBodyBytes: AUDIO_TRANSCRIPTION_MAX_INPUT_BYTES,
      timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS
    }
  },
  {
    contract: audioTranscribeArtifactRoute,
    effect: 'compute',
    callers: ['human', 'agent'],
    scopes: ['audio:transcribe', 'artifacts:read'],
    transport: 'rpc',
    approval: 'never',
    auditProjection: (input) => selectAuditFields(input, ['providerId', 'modelId', 'artifactId']),
    limits: {
      maxBodyBytes: 16 * 1024,
      timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS
    }
  },
  {
    contract: ocrGetRuntimeStatusRoute,
    effect: 'read',
    callers: ['human', 'agent'],
    scopes: ['ocr:read'],
    transport: 'rpc',
    approval: 'never',
    limits: DIAGNOSTIC_LIMITS
  },
  {
    contract: ocrExtractUploadRoute,
    effect: 'compute',
    callers: ['human'],
    scopes: ['ocr:extract'],
    transport: 'upload',
    approval: 'never',
    auditProjection: (input) =>
      selectAuditFields(input, [
        'mimeType',
        'backend',
        'sourcePageCountHint',
        'generationTokenLimit'
      ]),
    limits: {
      maxBodyBytes: OCR_EXTRACTION_MAX_INPUT_BYTES,
      timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS
    }
  },
  {
    contract: ocrExtractArtifactRoute,
    effect: 'compute',
    callers: ['human', 'agent'],
    scopes: ['ocr:extract', 'artifacts:read'],
    transport: 'rpc',
    approval: 'never',
    auditProjection: (input) =>
      selectAuditFields(input, [
        'artifactId',
        'backend',
        'sourcePageCountHint',
        'generationTokenLimit'
      ]),
    limits: {
      maxBodyBytes: 16 * 1024,
      timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS
    }
  },
  {
    contract: ocrClearCacheRoute,
    effect: 'local-maintenance',
    callers: ['human'],
    scopes: ['ocr:manage'],
    transport: 'rpc',
    approval: 'never',
    limits: {
      maxBodyBytes: 16 * 1024,
      timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS
    }
  },
  {
    contract: providersListPublicRoute,
    effect: 'read',
    callers: ['human', 'agent'],
    scopes: ['providers:read'],
    transport: 'rpc',
    approval: 'never',
    limits: DIAGNOSTIC_LIMITS
  },
  {
    contract: settingsGetPublicRoute,
    effect: 'read',
    callers: ['human', 'agent'],
    scopes: ['settings:read'],
    transport: 'rpc',
    approval: 'never',
    auditProjection: (input) => ({ keys: stringArrayField(input, 'keys') }),
    limits: DIAGNOSTIC_LIMITS
  },
  {
    contract: settingsUpdatePublicRoute,
    effect: {
      possible: ['preference-write', 'execution-config', 'security-config'],
      resolve: (input) => {
        const keys = settingChangeKeys(input)
        if (keys.every((key) => PREFERENCE_SETTING_KEYS.has(key))) return 'preference-write'
        if (keys.every((key) => EXECUTION_SETTING_KEYS.has(key))) return 'execution-config'
        return 'security-config'
      }
    },
    callers: ['human', 'agent'],
    scopes: ['settings:write'],
    transport: 'rpc',
    approval: 'policy',
    auditProjection: (input) => ({ keys: settingChangeKeys(input) }),
    approvalDisplay: (input) => ({ changes: settingChangesForDisplay(input) }),
    agentInputAllowed: (input) =>
      settingChangeKeys(input).every((key) => PREFERENCE_SETTING_KEYS.has(key)),
    limits: DIAGNOSTIC_LIMITS
  },
  {
    contract: artifactsDescribeRoute,
    effect: 'read',
    callers: ['human', 'agent'],
    scopes: ['artifacts:read'],
    transport: 'rpc',
    approval: 'never',
    auditProjection: (input) => selectAuditFields(input, ['id']),
    limits: DIAGNOSTIC_LIMITS
  },
  {
    contract: artifactsReadRoute,
    effect: 'read',
    callers: ['human'],
    scopes: ['artifacts:read'],
    transport: 'download',
    approval: 'never',
    auditProjection: (input) => selectAuditFields(input, ['id']),
    limits: { maxBodyBytes: 1, timeoutMs: 5 * 60_000 }
  },
  {
    contract: artifactsDeleteRoute,
    effect: 'local-maintenance',
    callers: ['human'],
    scopes: ['artifacts:manage'],
    transport: 'rpc',
    approval: 'never',
    auditProjection: (input) => selectAuditFields(input, ['id']),
    limits: DIAGNOSTIC_LIMITS
  },
  diagnosticEntry(cliStatusRoute),
  diagnosticEntry(cliVersionRoute),
  diagnosticEntry(cliCapabilitiesRoute),
  diagnosticEntry(cliDoctorRoute)
] as const

function createSurfaceRegistry(
  entries: readonly CliSurfaceEntry[]
): ReadonlyMap<string, CliSurfaceEntry> {
  const registry = new Map<string, CliSurfaceEntry>()
  for (const entry of entries) {
    if (registry.has(entry.contract.name)) {
      throw new Error(`Duplicate CLI surface method: ${entry.contract.name}`)
    }
    registry.set(entry.contract.name, entry)
  }
  return registry
}

export const CLI_SURFACE_V1 = createSurfaceRegistry(CLI_SURFACE_V1_ENTRIES)

export function getCliSurfaceEntry(method: string): CliSurfaceEntry | undefined {
  return CLI_SURFACE_V1.get(method)
}

export function listCliSurfaceCapabilities(): CliCapability[] {
  return Array.from(CLI_SURFACE_V1.values(), (entry) => ({
    method: entry.contract.name,
    possibleEffects: [...listCliSurfaceEffects(entry)],
    callers: [...entry.callers],
    scopes: [...entry.scopes],
    transport: entry.transport,
    approval: entry.approval,
    maxBodyBytes: entry.limits.maxBodyBytes,
    timeoutMs: entry.limits.timeoutMs
  })).sort((left, right) => left.method.localeCompare(right.method))
}
