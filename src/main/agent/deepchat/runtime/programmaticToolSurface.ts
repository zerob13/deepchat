import { Buffer } from 'node:buffer'
import type { MCPToolDefinition, ToolExecutionContract } from '@shared/types/core/mcp'
import type {
  DeepChatExecutionToolTargetIdentity,
  DeepChatExecutionWorkspaceCeiling
} from '@shared/types/execution-contract'
import type {
  DeepChatTaskContractContext,
  DeepChatTaskContractRef
} from '@shared/types/task-contract'
import { canonicalJsonStringifyData, hashJsonData } from '@/tape/domain/canonicalJson'
import { isToolEffectWithinCeiling } from '@/tape/domain/executionContract'
import { isDeepChatTaskContract, isDeepChatTaskContractRef } from '@/tape/domain/taskContract'
import {
  isWorkspacePathWithin,
  normalizeAbsoluteWorkspacePath
} from '@/tape/domain/workspacePath'
import {
  MAX_TOOL_SURFACE_DEFINITIONS,
  TOOL_SURFACE_CANONICALIZATION_VERSION,
  ToolSurfaceError,
  assertActiveToolSurfaceSnapshot,
  assertIssuedToolSurfaceRunCeiling,
  assertIssuedToolSurfaceSnapshot,
  buildCanonicalToolCatalog,
  createCliProgrammaticToolSurfaceRunControllerDelegate,
  type ToolSurfaceRunController,
  type ToolSurfaceRequestIdentity,
  type ToolSurfaceRunCeiling,
  type ToolSurfaceSnapshot
} from './toolSurface'

export const PROGRAMMATIC_TOOL_SURFACE_SCHEMA_VERSION = 1 as const
export const PROGRAMMATIC_TOOL_CAPABILITY_SCHEMA_VERSION = 1 as const
export const PROGRAMMATIC_TOOL_CAPABILITY_HASH_VERSION = 1 as const
export const PROGRAMMATIC_TOOL_ADAPTER_MODE = 'cli-programmatic' as const
export const MAX_PROGRAMMATIC_TOOL_SURFACE_ENTRIES = MAX_TOOL_SURFACE_DEFINITIONS
export const MAX_PROGRAMMATIC_TOOL_AUTHORITY_PROJECTION_BYTES = 1024 * 1024
export const MAX_PROGRAMMATIC_TOOL_CHILDREN = 64
export const MAX_PROGRAMMATIC_TOOL_BATCH_STEPS = 64
export const MAX_PROGRAMMATIC_TOOL_INPUT_BYTES = 4 * 1024 * 1024
export const MAX_PROGRAMMATIC_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024
export const MAX_PROGRAMMATIC_TOOL_DURATION_MS = 30 * 60_000

const CANONICAL_JSON_OPTIONS = Object.freeze({ omitUndefinedProperties: true })
const MAX_WORKSPACE_PATH_BYTES = 32 * 1024

export interface ProgrammaticToolSurfaceEntryV1 {
  readonly target: DeepChatExecutionToolTargetIdentity
  readonly stableTargetKey: string
  readonly canonicalToolDefinitionHash: string
  readonly execution: ToolExecutionContract
  /** Process-live only. Never persist or serialize this raw definition into a token or fact. */
  readonly definition: MCPToolDefinition
}

export interface ProgrammaticToolSurfaceV1 {
  readonly schemaVersion: typeof PROGRAMMATIC_TOOL_SURFACE_SCHEMA_VERSION
  readonly canonicalizationVersion: typeof TOOL_SURFACE_CANONICALIZATION_VERSION
  readonly catalogHash: string
  readonly surfaceHash: string
  readonly entries: readonly ProgrammaticToolSurfaceEntryV1[]
}

export interface ProgrammaticToolCapabilityCeilingsV1 {
  readonly maxToolEffect: 'read' | 'write'
  readonly workspace: DeepChatExecutionWorkspaceCeiling
  readonly maxSubagentDepth: number
}

export interface ProgrammaticToolCapabilityQuotasV1 {
  readonly maxChildren: number
  readonly maxBatchSteps: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxDurationMs: number
}

export interface ProgrammaticToolCapabilityV1 {
  readonly schemaVersion: typeof PROGRAMMATIC_TOOL_CAPABILITY_SCHEMA_VERSION
  readonly hashVersion: typeof PROGRAMMATIC_TOOL_CAPABILITY_HASH_VERSION
  readonly canonicalizationVersion: typeof TOOL_SURFACE_CANONICALIZATION_VERSION
  readonly adapterMode: typeof PROGRAMMATIC_TOOL_ADAPTER_MODE
  readonly policyVersion: string
  readonly request: ToolSurfaceRequestIdentity
  readonly catalogHash: string
  readonly programmaticSurfaceHash: string
  readonly entries: readonly ProgrammaticToolSurfaceEntryV1[]
  readonly taskContractRef: DeepChatTaskContractRef | null
  readonly ceilings: ProgrammaticToolCapabilityCeilingsV1
  readonly quotas: ProgrammaticToolCapabilityQuotasV1
  readonly capabilityHash: string
}

export interface CreateProgrammaticToolCapabilityInput {
  readonly snapshot: ToolSurfaceSnapshot
  readonly taskContractContext: DeepChatTaskContractContext | null
  readonly ceilings: ProgrammaticToolCapabilityCeilingsV1
  readonly quotas: ProgrammaticToolCapabilityQuotasV1
}

export interface ProgrammaticToolRunCeilingPreflightV1 {
  readonly catalogHash: string
  readonly maximumTargetCount: number
  readonly authorityProjectionBytes: number
}

export interface CreateProgrammaticToolSurfaceRunControllerInput {
  readonly ceilingDefinitions: readonly MCPToolDefinition[]
  readonly providerActiveDefinitions: readonly MCPToolDefinition[]
  readonly policyVersion: string
}

const issuedProgrammaticToolSurfaces = new WeakSet<ProgrammaticToolSurfaceV1>()
const issuedProgrammaticToolCapabilities = new WeakSet<ProgrammaticToolCapabilityV1>()
const programmaticToolRunPreflights = new WeakMap<
  ToolSurfaceRunCeiling,
  ProgrammaticToolRunCeilingPreflightV1
>()
const programmaticToolCapabilitySnapshots = new WeakMap<
  ProgrammaticToolCapabilityV1,
  ToolSurfaceSnapshot
>()
const programmaticToolSnapshotRunBindings = new WeakMap<
  ToolSurfaceSnapshot,
  {
    readonly maximumEntries: readonly ProgrammaticToolSurfaceEntryV1[]
  }
>()

function requirePositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ToolSurfaceError(`${label} is outside its supported bounds.`, 'limit_exceeded')
  }
  return value
}

function normalizeWorkspace(
  workspace: DeepChatExecutionWorkspaceCeiling
): DeepChatExecutionWorkspaceCeiling {
  if (!workspace || typeof workspace !== 'object') {
    throw new ToolSurfaceError('Programmatic workspace ceiling is invalid.', 'invalid_definition')
  }
  if (workspace.kind === 'runtime_default') {
    return Object.freeze({ kind: 'runtime_default' })
  }
  if (
    workspace.kind !== 'path' ||
    typeof workspace.path !== 'string' ||
    workspace.path.length === 0 ||
    workspace.path.includes('\0') ||
    Buffer.byteLength(workspace.path, 'utf8') > MAX_WORKSPACE_PATH_BYTES
  ) {
    throw new ToolSurfaceError('Programmatic workspace ceiling is invalid.', 'invalid_definition')
  }
  const normalized = normalizeAbsoluteWorkspacePath(workspace.path)
  if (normalized === null) {
    throw new ToolSurfaceError('Programmatic workspace must be absolute.', 'invalid_definition')
  }
  return Object.freeze({ kind: 'path', path: normalized.path })
}

function normalizeCeilings(
  ceilings: ProgrammaticToolCapabilityCeilingsV1,
  surface: ProgrammaticToolSurfaceV1,
  maximumEntries: readonly ProgrammaticToolSurfaceEntryV1[]
): ProgrammaticToolCapabilityCeilingsV1 {
  if (
    !ceilings ||
    typeof ceilings !== 'object' ||
    (ceilings.maxToolEffect !== 'read' && ceilings.maxToolEffect !== 'write') ||
    !Number.isSafeInteger(ceilings.maxSubagentDepth) ||
    ceilings.maxSubagentDepth < 0 ||
    ceilings.maxSubagentDepth > 1
  ) {
    throw new ToolSurfaceError('Programmatic execution ceilings are invalid.', 'invalid_definition')
  }
  const currentSurfaceExceedsEffect = surface.entries.some(
    (entry) => !isToolEffectWithinCeiling(entry.execution.effect, ceilings.maxToolEffect)
  )
  const maximumRunSurfaceExceedsEffect = maximumEntries.some(
    (entry) => !isToolEffectWithinCeiling(entry.execution.effect, ceilings.maxToolEffect)
  )
  if (currentSurfaceExceedsEffect || maximumRunSurfaceExceedsEffect) {
    throw new ToolSurfaceError(
      'Programmatic Surface exceeds its effect ceiling.',
      'ineligible_exposure'
    )
  }
  return Object.freeze({
    maxToolEffect: ceilings.maxToolEffect,
    workspace: normalizeWorkspace(ceilings.workspace),
    maxSubagentDepth: ceilings.maxSubagentDepth
  })
}

function normalizeQuotas(
  quotas: ProgrammaticToolCapabilityQuotasV1
): ProgrammaticToolCapabilityQuotasV1 {
  if (!quotas || typeof quotas !== 'object') {
    throw new ToolSurfaceError('Programmatic invocation quotas are invalid.', 'invalid_definition')
  }
  const normalized = {
    maxChildren: requirePositiveInteger(
      quotas.maxChildren,
      MAX_PROGRAMMATIC_TOOL_CHILDREN,
      'Programmatic child quota'
    ),
    maxBatchSteps: requirePositiveInteger(
      quotas.maxBatchSteps,
      MAX_PROGRAMMATIC_TOOL_BATCH_STEPS,
      'Programmatic batch quota'
    ),
    maxInputBytes: requirePositiveInteger(
      quotas.maxInputBytes,
      MAX_PROGRAMMATIC_TOOL_INPUT_BYTES,
      'Programmatic input quota'
    ),
    maxOutputBytes: requirePositiveInteger(
      quotas.maxOutputBytes,
      MAX_PROGRAMMATIC_TOOL_OUTPUT_BYTES,
      'Programmatic output quota'
    ),
    maxDurationMs: requirePositiveInteger(
      quotas.maxDurationMs,
      MAX_PROGRAMMATIC_TOOL_DURATION_MS,
      'Programmatic duration quota'
    )
  }
  if (normalized.maxBatchSteps > normalized.maxChildren) {
    throw new ToolSurfaceError(
      'Programmatic batch quota exceeds the child quota.',
      'invalid_definition'
    )
  }
  return Object.freeze(normalized)
}

function isWorkspaceWithinTaskCeiling(
  workspace: DeepChatExecutionWorkspaceCeiling,
  taskWorkspace: DeepChatExecutionWorkspaceCeiling
): boolean {
  if (workspace.kind === 'runtime_default' || taskWorkspace.kind === 'runtime_default') {
    return workspace.kind === taskWorkspace.kind
  }
  return isWorkspacePathWithin(workspace.path, taskWorkspace.path)
}

function normalizeTaskContractContext(
  context: DeepChatTaskContractContext | null,
  request: ToolSurfaceRequestIdentity,
  ceilings: ProgrammaticToolCapabilityCeilingsV1
): DeepChatTaskContractRef | null {
  if (context === null) return null
  if (
    !context ||
    typeof context !== 'object' ||
    !isDeepChatTaskContract(context.contract) ||
    !isDeepChatTaskContractRef(context.localRef) ||
    context.localRef.sessionId !== request.sessionId ||
    context.localRef.contractHash !== context.contract.contractHash
  ) {
    throw new ToolSurfaceError(
      'Programmatic TaskContract context does not belong to the request Session.',
      'invalid_definition'
    )
  }
  const taskCeilings = context.contract.taskHarness.ceilings
  if (
    !isToolEffectWithinCeiling(ceilings.maxToolEffect, taskCeilings.maxToolEffect) ||
    !isWorkspaceWithinTaskCeiling(ceilings.workspace, taskCeilings.workspace) ||
    ceilings.maxSubagentDepth > taskCeilings.maxSubagentDepth
  ) {
    throw new ToolSurfaceError(
      'Programmatic execution ceilings exceed the TaskContract.',
      'ineligible_exposure'
    )
  }
  return Object.freeze({ ...context.localRef })
}

function surfaceHashInput(surface: Omit<ProgrammaticToolSurfaceV1, 'surfaceHash'>): object {
  return {
    schemaVersion: surface.schemaVersion,
    canonicalizationVersion: surface.canonicalizationVersion,
    catalogHash: surface.catalogHash,
    entries: surface.entries.map((entry) => ({
      target: entry.target,
      stableTargetKey: entry.stableTargetKey,
      canonicalToolDefinitionHash: entry.canonicalToolDefinitionHash,
      execution: entry.execution
    }))
  }
}

function capabilityHashInput(
  capability: Omit<ProgrammaticToolCapabilityV1, 'capabilityHash'>
): object {
  return {
    schemaVersion: capability.schemaVersion,
    hashVersion: capability.hashVersion,
    canonicalizationVersion: capability.canonicalizationVersion,
    adapterMode: capability.adapterMode,
    policyVersion: capability.policyVersion,
    request: capability.request,
    catalogHash: capability.catalogHash,
    programmaticSurfaceHash: capability.programmaticSurfaceHash,
    entries: capability.entries.map((entry) => ({
      target: entry.target,
      stableTargetKey: entry.stableTargetKey,
      canonicalToolDefinitionHash: entry.canonicalToolDefinitionHash,
      execution: entry.execution
    })),
    taskContractRef: capability.taskContractRef,
    ceilings: capability.ceilings,
    quotas: capability.quotas
  }
}

function measureCanonicalAuthorityProjection(value: object, label: string): number {
  const bytes = Buffer.byteLength(
    canonicalJsonStringifyData(value, CANONICAL_JSON_OPTIONS),
    'utf8'
  )
  if (bytes > MAX_PROGRAMMATIC_TOOL_AUTHORITY_PROJECTION_BYTES) {
    throw new ToolSurfaceError(
      `${label} exceeds ${MAX_PROGRAMMATIC_TOOL_AUTHORITY_PROJECTION_BYTES} canonical authority bytes.`,
      'limit_exceeded'
    )
  }
  return bytes
}

function projectProgrammaticEntries(
  ceiling: ToolSurfaceRunCeiling,
  catalogEntries: ToolSurfaceSnapshot['eligibleCatalog']['entries'],
  providerActiveTargets: ReadonlySet<string>
): readonly ProgrammaticToolSurfaceEntryV1[] {
  const ceilingEntryByTarget = new Map(
    ceiling.entries.map((entry) => [entry.catalogEntry.stableTargetKey, entry])
  )
  const entries = catalogEntries
    .filter(
      (entry) => entry.target.source === 'mcp' && !providerActiveTargets.has(entry.stableTargetKey)
    )
    .map((entry): ProgrammaticToolSurfaceEntryV1 => {
      const ceilingEntry = ceilingEntryByTarget.get(entry.stableTargetKey)
      if (
        !ceilingEntry ||
        ceilingEntry.catalogEntry.canonicalToolDefinitionHash !==
          entry.canonicalToolDefinitionHash
      ) {
        throw new ToolSurfaceError(
          'Programmatic Surface lost its frozen Run definition.',
          'conflicting_tool'
        )
      }
      return Object.freeze({
        target: entry.target,
        stableTargetKey: entry.stableTargetKey,
        canonicalToolDefinitionHash: entry.canonicalToolDefinitionHash,
        execution: entry.execution,
        definition: ceilingEntry.definition
      })
    })
  if (entries.length > MAX_PROGRAMMATIC_TOOL_SURFACE_ENTRIES) {
    throw new ToolSurfaceError(
      'Programmatic Surface exceeds its target limit.',
      'limit_exceeded'
    )
  }
  return Object.freeze(entries)
}

export function preflightProgrammaticToolRunCeilingV1(input: {
  readonly ceiling: ToolSurfaceRunCeiling
}): ProgrammaticToolRunCeilingPreflightV1 {
  if (!input || typeof input !== 'object') {
    throw new ToolSurfaceError(
      'Programmatic Run ceiling preflight input is invalid.',
      'invalid_definition'
    )
  }
  assertIssuedToolSurfaceRunCeiling(input.ceiling)
  const cached = programmaticToolRunPreflights.get(input.ceiling)
  if (cached) return cached
  const { preflight } = buildProgrammaticToolRunProjection(input.ceiling, new Set())
  programmaticToolRunPreflights.set(input.ceiling, preflight)
  return preflight
}

function buildProgrammaticToolRunProjection(
  ceiling: ToolSurfaceRunCeiling,
  providerActiveTargets: ReadonlySet<string>
): {
  readonly entries: readonly ProgrammaticToolSurfaceEntryV1[]
  readonly preflight: ProgrammaticToolRunCeilingPreflightV1
} {
  const entries = projectProgrammaticEntries(
    ceiling,
    ceiling.catalog.entries,
    providerActiveTargets
  )
  const projection = surfaceHashInput({
    schemaVersion: PROGRAMMATIC_TOOL_SURFACE_SCHEMA_VERSION,
    canonicalizationVersion: TOOL_SURFACE_CANONICALIZATION_VERSION,
    catalogHash: ceiling.catalog.fullCatalogHash,
    entries
  })
  const preflight = Object.freeze({
    catalogHash: ceiling.catalog.fullCatalogHash,
    maximumTargetCount: entries.length,
    authorityProjectionBytes: measureCanonicalAuthorityProjection(
      projection,
      'Programmatic Run ceiling'
    )
  })
  return Object.freeze({ entries, preflight })
}

export function createProgrammaticToolSurfaceRunControllerV1(
  input: CreateProgrammaticToolSurfaceRunControllerInput
): ToolSurfaceRunController {
  if (!input || typeof input !== 'object') {
    throw new ToolSurfaceError(
      'Programmatic Tool Surface Run input is invalid.',
      'invalid_definition'
    )
  }
  const delegate = createCliProgrammaticToolSurfaceRunControllerDelegate(input)
  const providerActiveCatalog = buildCanonicalToolCatalog(input.providerActiveDefinitions)
  const providerActiveTargets = new Set(
    providerActiveCatalog.entries.map((entry) => entry.stableTargetKey)
  )
  const { entries: maximumEntries } = buildProgrammaticToolRunProjection(
    delegate.ceiling,
    providerActiveTargets
  )
  const controller: ToolSurfaceRunController = {
    ceiling: delegate.ceiling,
    policyVersion: delegate.policyVersion,
    adapterMode: delegate.adapterMode,
    virtualizationTriggered: delegate.virtualizationTriggered,
    stageActivationBatch: (candidates) => delegate.stageActivationBatch(candidates),
    build: (buildInput) => {
      const snapshot = delegate.build(buildInput)
      programmaticToolSnapshotRunBindings.set(snapshot, { maximumEntries })
      return snapshot
    },
    admit: (snapshot) => delegate.admit(snapshot)
  }
  return Object.freeze(controller)
}

export function buildProgrammaticToolSurfaceV1(
  snapshot: ToolSurfaceSnapshot
): ProgrammaticToolSurfaceV1 {
  assertIssuedToolSurfaceSnapshot(snapshot)
  const activeTargets = new Set(snapshot.activeEntries.map((entry) => entry.stableTargetKey))
  const entries = projectProgrammaticEntries(
    snapshot.ceiling,
    snapshot.eligibleCatalog.entries,
    activeTargets
  )
  const draft: Omit<ProgrammaticToolSurfaceV1, 'surfaceHash'> = {
    schemaVersion: PROGRAMMATIC_TOOL_SURFACE_SCHEMA_VERSION,
    canonicalizationVersion: TOOL_SURFACE_CANONICALIZATION_VERSION,
    catalogHash: snapshot.eligibleCatalog.fullCatalogHash,
    entries: Object.freeze(entries)
  }
  const hashInput = surfaceHashInput(draft)
  measureCanonicalAuthorityProjection(hashInput, 'Programmatic Surface')
  const surface = Object.freeze({
    ...draft,
    surfaceHash: hashJsonData(hashInput, CANONICAL_JSON_OPTIONS)
  })
  issuedProgrammaticToolSurfaces.add(surface)
  return surface
}

export function buildProgrammaticToolCapabilityV1(
  input: CreateProgrammaticToolCapabilityInput
): ProgrammaticToolCapabilityV1 {
  if (!input || typeof input !== 'object') {
    throw new ToolSurfaceError('Programmatic capability input is invalid.', 'invalid_definition')
  }
  assertIssuedToolSurfaceSnapshot(input.snapshot)
  if (input.snapshot.adapterMode !== PROGRAMMATIC_TOOL_ADAPTER_MODE) {
    throw new ToolSurfaceError(
      'Programmatic capability requires a CLI Programmatic Run.',
      'ineligible_exposure'
    )
  }
  const runBinding = programmaticToolSnapshotRunBindings.get(input.snapshot)
  if (!runBinding) {
    throw new ToolSurfaceError(
      'Programmatic capability requires its canonical Run controller binding.',
      'ineligible_exposure'
    )
  }
  const surface = buildProgrammaticToolSurfaceV1(input.snapshot)
  const request = Object.freeze({ ...input.snapshot.request })
  const ceilings = normalizeCeilings(input.ceilings, surface, runBinding.maximumEntries)
  const draft: Omit<ProgrammaticToolCapabilityV1, 'capabilityHash'> = {
    schemaVersion: PROGRAMMATIC_TOOL_CAPABILITY_SCHEMA_VERSION,
    hashVersion: PROGRAMMATIC_TOOL_CAPABILITY_HASH_VERSION,
    canonicalizationVersion: TOOL_SURFACE_CANONICALIZATION_VERSION,
    adapterMode: PROGRAMMATIC_TOOL_ADAPTER_MODE,
    policyVersion: input.snapshot.policyVersion,
    request,
    catalogHash: surface.catalogHash,
    programmaticSurfaceHash: surface.surfaceHash,
    entries: surface.entries,
    taskContractRef: normalizeTaskContractContext(
      input.taskContractContext,
      request,
      ceilings
    ),
    ceilings,
    quotas: normalizeQuotas(input.quotas)
  }
  const hashInput = capabilityHashInput(draft)
  measureCanonicalAuthorityProjection(hashInput, 'Programmatic capability')
  const capability = Object.freeze({
    ...draft,
    capabilityHash: hashJsonData(hashInput, CANONICAL_JSON_OPTIONS)
  })
  issuedProgrammaticToolCapabilities.add(capability)
  programmaticToolCapabilitySnapshots.set(capability, input.snapshot)
  return capability
}

export function assertIssuedProgrammaticToolCapability(
  capability: unknown
): asserts capability is ProgrammaticToolCapabilityV1 {
  if (
    !capability ||
    typeof capability !== 'object' ||
    !issuedProgrammaticToolCapabilities.has(capability as ProgrammaticToolCapabilityV1)
  ) {
    throw new ToolSurfaceError(
      'Programmatic capability was not issued by the canonical builder.',
      'invalid_definition'
    )
  }
}

/**
 * Proves exact provider-View liveness only. `expectedSnapshot` must come from the runtime-owned
 * active request binding; every target call must still recheck runtime authority.
 */
export function assertProgrammaticToolCapabilityViewActive(
  capability: unknown,
  expectedSnapshot: unknown
): asserts capability is ProgrammaticToolCapabilityV1 {
  assertIssuedProgrammaticToolCapability(capability)
  assertIssuedToolSurfaceSnapshot(expectedSnapshot)
  const snapshot = programmaticToolCapabilitySnapshots.get(capability)
  if (!snapshot || snapshot !== expectedSnapshot) {
    throw new ToolSurfaceError(
      'Programmatic capability does not belong to the current provider View.',
      'invalid_definition'
    )
  }
  assertActiveToolSurfaceSnapshot(snapshot)
}

export function assertIssuedProgrammaticToolSurface(
  surface: unknown
): asserts surface is ProgrammaticToolSurfaceV1 {
  if (
    !surface ||
    typeof surface !== 'object' ||
    !issuedProgrammaticToolSurfaces.has(surface as ProgrammaticToolSurfaceV1)
  ) {
    throw new ToolSurfaceError(
      'Programmatic Surface was not issued by the canonical builder.',
      'invalid_definition'
    )
  }
}
