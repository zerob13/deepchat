import { Buffer } from 'node:buffer'
import { types as nodeTypes } from 'node:util'
import type { AgentToolExposure } from '@shared/agentTools'
import {
  TOOL_SEARCH_AGENT_TOOL_MAX_CALLS_PER_BATCH,
  TOOL_SEARCH_AGENT_TOOL_NAME,
  TOOL_SEARCH_AGENT_TOOL_SERVER_NAME,
  getAgentToolExposure
} from '@shared/agentTools'
import {
  stripToolExecutionContract,
  type MCPToolDefinition,
  type ToolExecutionContract
} from '@shared/types/core/mcp'
import type { DeepChatExecutionToolTargetIdentity } from '@shared/types/execution-contract'
import { canonicalJsonStringifyData, hashJsonData } from '@/tape/domain/canonicalJson'
import {
  buildExecutionToolCeiling,
  buildExecutionToolTargetKey,
  buildProviderVisibleToolDefinitionsHash
} from '@/tape/domain/executionContract'
import { estimateToolDefinitionTokens } from './contextBuilder'

export const TOOL_SURFACE_CATALOG_SCHEMA_VERSION = 1
export const TOOL_SURFACE_SNAPSHOT_SCHEMA_VERSION = 1
export const TOOL_SURFACE_CANONICALIZATION_VERSION = 'deepchat-tool-definition-v1'
export const TOOL_SURFACE_ORDERING_VERSION = 'activation-ordinal-v1'
export const FULL_TOOL_SURFACE_POLICY_VERSION = 'full-v1'
export const MAX_TOOL_SURFACE_DEFINITIONS = 1_024
export const MAX_TOOL_SURFACE_DEFINITION_BYTES = 256 * 1_024
export const MAX_TOOL_SURFACE_TOTAL_DEFINITION_BYTES = 4 * 1_024 * 1_024
export const MAX_TOOL_SURFACE_DEFINITION_DEPTH = 64
export const MAX_TOOL_SURFACE_DEFINITION_NODES = 100_000
export const MAX_TOOL_SURFACE_TOTAL_INPUT_NODES = 500_000
export const MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES = 4 * 1_024 * 1_024
export const MAX_TOOL_SURFACE_SELECTION_HINTS = MAX_TOOL_SURFACE_DEFINITIONS
export const MAX_TOOL_SURFACE_OVERLAP_IDENTITIES = MAX_TOOL_SURFACE_DEFINITIONS
export const MAX_TOOL_SURFACE_HINT_INPUT_BYTES = MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES
export const MAX_TOOL_SURFACE_CANDIDATE_BATCHES = 1_024
export const MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES = 4_096
export const MAX_TOOL_SURFACE_SEARCH_CALLS_PER_BATCH =
  TOOL_SEARCH_AGENT_TOOL_MAX_CALLS_PER_BATCH

const CANONICAL_JSON_OPTIONS = Object.freeze({ omitUndefinedProperties: true })
const MAX_TOOL_SURFACE_REQUEST_ID_BYTES = 1_024
const TOOL_SURFACE_SELECTION_REASONS = Object.freeze([
  'full-catalog',
  'policy-required',
  'core',
  'active-skill',
  'recent',
  'search-result',
  'tool-search'
] as const)
const TOOL_SURFACE_ACTIVATION_REJECTION_CODES = Object.freeze([
  'ineligible',
  'definition-drift',
  'per-batch-count-cap',
  'per-batch-token-cap',
  'per-run-batch-cap',
  'per-run-target-cap',
  'total-surface-count-cap',
  'total-surface-token-cap'
] as const)
// Run ceilings are process-live immutable capabilities, not serializable authority or latest state.
const issuedRunToolCeilings = new WeakSet<ToolSurfaceRunCeiling>()
// View snapshots follow the same process-live provenance discipline as their Run ceilings.
const issuedToolSurfaceSnapshots = new WeakSet<ToolSurfaceSnapshot>()
// Only admitted Views may issue execution capabilities to tool dispatch.
const admittedToolSurfaceSnapshots = new WeakSet<ToolSurfaceSnapshot>()
// Recovery, replacement, and terminal settlement revoke unused execution eligibility.
const revokedToolSurfaceExecutionSnapshots = new WeakSet<ToolSurfaceSnapshot>()
// A provider response may settle at most one execution batch for its admitted View.
const executionBatchIssuedToolSurfaceSnapshots = new WeakSet<ToolSurfaceSnapshot>()
// Tool execution contexts are request-local capabilities derived from one issued virtualized View.
const issuedToolSurfaceExecutionContexts = new WeakSet<ToolSurfaceExecutionContext>()

export type ToolSurfaceErrorCode =
  | 'conflicting_tool'
  | 'ineligible_exposure'
  | 'invalid_definition'
  | 'limit_exceeded'

export class ToolSurfaceError extends Error {
  constructor(
    message: string,
    readonly code: ToolSurfaceErrorCode
  ) {
    super(message)
    this.name = 'ToolSurfaceError'
  }
}

export interface CanonicalToolCatalogEntry {
  readonly target: DeepChatExecutionToolTargetIdentity
  readonly stableTargetKey: string
  readonly canonicalToolDefinitionHash: string
  readonly exposure: Extract<AgentToolExposure, 'user-configurable' | 'system-model'>
  readonly execution: ToolExecutionContract
  readonly definitionTokens: number
  readonly canonicalDefinitionBytes: number
}

export interface CanonicalToolCatalog {
  readonly schemaVersion: typeof TOOL_SURFACE_CATALOG_SCHEMA_VERSION
  readonly canonicalizationVersion: typeof TOOL_SURFACE_CANONICALIZATION_VERSION
  readonly fullCatalogHash: string
  readonly entries: readonly CanonicalToolCatalogEntry[]
  readonly definitionTokens: number
  readonly canonicalDefinitionBytes: number
}

export interface ToolSurfaceRunCeilingEntry {
  readonly catalogEntry: CanonicalToolCatalogEntry
  readonly definition: MCPToolDefinition
}

export interface ToolSurfaceRunCeiling {
  readonly catalog: CanonicalToolCatalog
  readonly entries: readonly ToolSurfaceRunCeilingEntry[]
}

export type ToolSurfaceSelectionReason =
  | 'full-catalog'
  | 'policy-required'
  | 'core'
  | 'active-skill'
  | 'recent'
  | 'search-result'
  | 'tool-search'

export type ToolSurfaceShadowTriggerReason =
  | 'none'
  | 'tool-count'
  | 'estimated-input-tokens'
  | 'tool-count-and-estimated-input-tokens'
  | 'hysteresis'

export type ToolSurfaceShadowDegradationCode =
  | 'invalid-policy'
  | 'eligible-catalog-invalid'
  | 'selection-input-limit-exceeded'
  | 'mandatory-target-missing'
  | 'mandatory-budget-exceeded'

export interface ToolSurfaceShadowPolicy {
  readonly policyVersion: string
  readonly enterToolCount: number
  readonly exitToolCount: number
  readonly enterEstimatedInputTokens: number
  readonly exitEstimatedInputTokens: number
  readonly maxInitialToolCount: number
  readonly maxInitialDefinitionTokens: number
  readonly activationReserveToolCount: number
  readonly activationReserveDefinitionTokens: number
  readonly maxActivationCandidatesPerBatch: number
  readonly maxActivationCandidateDefinitionTokensPerBatch: number
  readonly maxActivationBatchesPerRun: number
  readonly maxAppendedTargetsPerRun: number
  readonly toolSearchDefinitionTokens: number
  readonly toolSearchPromptTokens: number
}

export interface ToolSurfaceShadowSelectionEntry {
  readonly stableTargetKey: string
  readonly definitionTokens: number
  readonly reason: ToolSurfaceSelectionReason
  readonly required: boolean
}

export interface ToolSurfaceDefinitionIdentity {
  readonly stableTargetKey: string
  readonly canonicalToolDefinitionHash: string
}

export interface ToolSurfaceActivationOrderEntry extends ToolSurfaceDefinitionIdentity {
  readonly activationOrdinal: number
}

export interface ToolSurfaceActivationLedger {
  readonly orderingVersion: typeof TOOL_SURFACE_ORDERING_VERSION
  readonly entries: readonly ToolSurfaceActivationOrderEntry[]
}

export interface ToolSurfaceRequestIdentity {
  readonly sessionId: string
  readonly messageId: string
  readonly runId: string
  readonly requestSeq: number
}

export interface ToolSurfaceSnapshotActiveEntry extends ToolSurfaceActivationOrderEntry {
  readonly reason: ToolSurfaceSelectionReason
  readonly definition: MCPToolDefinition
}

export interface ToolSurfaceSnapshot {
  readonly schemaVersion: typeof TOOL_SURFACE_SNAPSHOT_SCHEMA_VERSION
  readonly canonicalizationVersion: typeof TOOL_SURFACE_CANONICALIZATION_VERSION
  readonly orderingVersion: typeof TOOL_SURFACE_ORDERING_VERSION
  readonly request: ToolSurfaceRequestIdentity
  readonly policyVersion: string
  readonly virtualizationTriggered: boolean
  readonly ceiling: ToolSurfaceRunCeiling
  readonly eligibleCatalog: CanonicalToolCatalog
  readonly activeEntries: readonly ToolSurfaceSnapshotActiveEntry[]
  readonly toolDefinitions: readonly MCPToolDefinition[]
  readonly activation: ToolSurfaceSnapshotActivation
}

export type ToolSurfaceActivationRejectionCode =
  | 'ineligible'
  | 'definition-drift'
  | 'per-batch-count-cap'
  | 'per-batch-token-cap'
  | 'per-run-batch-cap'
  | 'per-run-target-cap'
  | 'total-surface-count-cap'
  | 'total-surface-token-cap'

export interface ToolSurfaceActivationDecision extends ToolSurfaceActivationCandidate {
  readonly accepted: boolean
  readonly rejectionCode?: ToolSurfaceActivationRejectionCode
}

export interface ToolSurfaceSnapshotActivation {
  readonly originRequestSeq: number | null
  readonly decisions: readonly ToolSurfaceActivationDecision[]
}

export interface ToolSurfaceRunController {
  readonly ceiling: ToolSurfaceRunCeiling
  readonly policyVersion: string
  readonly virtualizationTriggered: boolean
  build(input: {
    readonly request: ToolSurfaceRequestIdentity
    readonly eligibleDefinitions: readonly MCPToolDefinition[]
    readonly toolSearchAvailable?: boolean
  }): ToolSurfaceSnapshot
  stageActivationBatch(candidates: readonly ToolSurfaceActivationCandidate[]): void
  admit(snapshot: ToolSurfaceSnapshot): void
}

export type FullToolSurfaceRunController = ToolSurfaceRunController
export type ToolSurfaceSelectionPolicy = ToolSurfaceShadowPolicy
export type ToolSurfaceSelectionDecision = ToolSurfaceShadowDecision

export interface PolicySelectedToolSurfaceRun {
  readonly decision: ToolSurfaceSelectionDecision
  readonly controller: ToolSurfaceRunController
}

export function assertIssuedToolSurfaceSnapshot(
  snapshot: unknown
): asserts snapshot is ToolSurfaceSnapshot {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !issuedToolSurfaceSnapshots.has(snapshot as ToolSurfaceSnapshot)
  ) {
    throw new ToolSurfaceError(
      'Tool Surface snapshot was not issued by the canonical builder.',
      'invalid_definition'
    )
  }
}

export function revokeToolSurfaceExecutionEligibility(snapshot: ToolSurfaceSnapshot): void {
  assertIssuedToolSurfaceSnapshot(snapshot)
  revokedToolSurfaceExecutionSnapshots.add(snapshot)
}

export interface ToolSurfaceCandidateScope {
  readonly sessionId: string
  readonly messageId: string
  readonly runId: string
}

export interface ToolSurfaceActivationCandidate extends ToolSurfaceDefinitionIdentity {
  readonly sessionId: string
  readonly messageId: string
  readonly runId: string
  readonly requestSeq: number
  readonly toolCallOrdinalWithinBatch: number
  readonly resultRank: number
}

export interface ToolSurfaceExecutionContext {
  readonly snapshot: ToolSurfaceSnapshot
  readonly toolCallOrdinalWithinBatch: number
  readonly submitActivationCandidates: (
    candidates: readonly ToolSurfaceActivationCandidate[]
  ) => void
}

const TOOL_SURFACE_EXECUTION_CONTEXT_ACTIVE = Symbol('tool-surface-execution-context-active')

type IssuedToolSurfaceExecutionContext = ToolSurfaceExecutionContext & {
  readonly [TOOL_SURFACE_EXECUTION_CONTEXT_ACTIVE]: () => boolean
}

export interface ToolSurfaceExecutionBatch {
  readonly snapshot: ToolSurfaceSnapshot
  createContext(toolCallOrdinalWithinBatch: number): ToolSurfaceExecutionContext
  acceptToolCallCandidates(toolCallOrdinalWithinBatch: number): void
  seal(): readonly ToolSurfaceActivationCandidate[]
  discard(): void
}

export function createToolSurfaceExecutionBatch(input: {
  readonly snapshot: ToolSurfaceSnapshot
}): ToolSurfaceExecutionBatch {
  assertIssuedToolSurfaceSnapshot(input.snapshot)
  if (
    !admittedToolSurfaceSnapshots.has(input.snapshot) ||
    revokedToolSurfaceExecutionSnapshots.has(input.snapshot) ||
    !input.snapshot.virtualizationTriggered ||
    !input.snapshot.activeEntries.some(
      (entry) => entry.definition.function.name === TOOL_SEARCH_AGENT_TOOL_NAME
    )
  ) {
    throw new ToolSurfaceError(
      'Tool Surface execution batch is not bound to a virtualized ToolSearch View.',
      'invalid_definition'
    )
  }
  if (executionBatchIssuedToolSurfaceSnapshots.has(input.snapshot)) {
    throw new ToolSurfaceError(
      'Tool Surface execution batch was already issued for this provider View.',
      'invalid_definition'
    )
  }
  executionBatchIssuedToolSurfaceSnapshots.add(input.snapshot)
  let active = true
  let sealedCandidates: readonly ToolSurfaceActivationCandidate[] | null = null
  const candidateBatchesByToolCall = new Map<
    number,
    (readonly ToolSurfaceActivationCandidate[])[]
  >()
  const acceptedToolCallOrdinals = new Set<number>()
  let retainedSubmissionCount = 0
  let retainedCandidateCount = 0
  let retainedCandidateBytes = 0
  const assertActive = (): void => {
    if (!active || revokedToolSurfaceExecutionSnapshots.has(input.snapshot)) {
      throw new ToolSurfaceError(
        'Tool Surface execution context is no longer active.',
        'invalid_definition'
      )
    }
  }
  const createContext = (toolCallOrdinalWithinBatch: number): ToolSurfaceExecutionContext => {
    assertActive()
    if (!Number.isSafeInteger(toolCallOrdinalWithinBatch) || toolCallOrdinalWithinBatch < 0) {
      throw new ToolSurfaceError(
        'Tool Surface execution context has an invalid tool call ordinal.',
        'invalid_definition'
      )
    }
    if (candidateBatchesByToolCall.has(toolCallOrdinalWithinBatch)) {
      throw new ToolSurfaceError(
        'Tool Surface execution context was already issued for this tool call.',
        'invalid_definition'
      )
    }
    if (candidateBatchesByToolCall.size >= MAX_TOOL_SURFACE_SEARCH_CALLS_PER_BATCH) {
      throw new ToolSurfaceError(
        `Tool Surface batch has more than ${MAX_TOOL_SURFACE_SEARCH_CALLS_PER_BATCH} ToolSearch calls.`,
        'limit_exceeded'
      )
    }
    const candidateBatches: (readonly ToolSurfaceActivationCandidate[])[] = []
    candidateBatchesByToolCall.set(toolCallOrdinalWithinBatch, candidateBatches)
    const context = Object.freeze({
      snapshot: input.snapshot,
      toolCallOrdinalWithinBatch,
      submitActivationCandidates: (candidates: readonly ToolSurfaceActivationCandidate[]) => {
        assertActive()
        const normalized = mergeToolSurfaceActivationCandidates(input.snapshot.request, [candidates])
        if (
          normalized.some(
            (candidate) =>
              candidate.requestSeq !== input.snapshot.request.requestSeq ||
              candidate.toolCallOrdinalWithinBatch !== toolCallOrdinalWithinBatch
          )
        ) {
          throw new ToolSurfaceError(
            'Tool Surface activation candidates do not match their originating tool call.',
            'invalid_definition'
          )
        }
        if (normalized.length === 0) return
        const normalizedBytes = Buffer.byteLength(
          canonicalJsonStringifyData(normalized),
          'utf8'
        )
        const nextSubmissionCount = retainedSubmissionCount + 1
        const nextCandidateCount = retainedCandidateCount + normalized.length
        const nextCandidateBytes = retainedCandidateBytes + normalizedBytes
        if (
          !Number.isSafeInteger(nextSubmissionCount) ||
          !Number.isSafeInteger(nextCandidateCount) ||
          !Number.isSafeInteger(nextCandidateBytes) ||
          nextSubmissionCount > MAX_TOOL_SURFACE_CANDIDATE_BATCHES ||
          nextCandidateCount > MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES ||
          nextCandidateBytes > MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES
        ) {
          throw new ToolSurfaceError(
            'Tool Surface execution batch exceeds its retained candidate limit.',
            'limit_exceeded'
          )
        }
        candidateBatches.push(normalized)
        retainedSubmissionCount = nextSubmissionCount
        retainedCandidateCount = nextCandidateCount
        retainedCandidateBytes = nextCandidateBytes
      },
      [TOOL_SURFACE_EXECUTION_CONTEXT_ACTIVE]: () =>
        active && !revokedToolSurfaceExecutionSnapshots.has(input.snapshot)
    })
    issuedToolSurfaceExecutionContexts.add(context)
    return context
  }
  const acceptToolCallCandidates = (toolCallOrdinalWithinBatch: number): void => {
    assertActive()
    if (!candidateBatchesByToolCall.has(toolCallOrdinalWithinBatch)) {
      throw new ToolSurfaceError(
        'Tool Surface candidates cannot be accepted for an unissued tool call.',
        'invalid_definition'
      )
    }
    acceptedToolCallOrdinals.add(toolCallOrdinalWithinBatch)
  }
  const seal = (): readonly ToolSurfaceActivationCandidate[] => {
    if (sealedCandidates) return sealedCandidates
    assertActive()
    active = false
    try {
      const acceptedCandidateBatches = [...acceptedToolCallOrdinals]
        .sort((left, right) => left - right)
        .flatMap((ordinal) => candidateBatchesByToolCall.get(ordinal) ?? [])
      sealedCandidates = mergeToolSurfaceActivationCandidates(
        input.snapshot.request,
        acceptedCandidateBatches
      )
      return sealedCandidates
    } finally {
      candidateBatchesByToolCall.clear()
      acceptedToolCallOrdinals.clear()
      retainedSubmissionCount = 0
      retainedCandidateCount = 0
      retainedCandidateBytes = 0
    }
  }
  const discard = (): void => {
    active = false
    candidateBatchesByToolCall.clear()
    acceptedToolCallOrdinals.clear()
    retainedSubmissionCount = 0
    retainedCandidateCount = 0
    retainedCandidateBytes = 0
  }

  return Object.freeze({
    snapshot: input.snapshot,
    createContext,
    acceptToolCallCandidates,
    seal,
    discard
  })
}

export function assertIssuedToolSurfaceExecutionContext(
  context: unknown
): asserts context is ToolSurfaceExecutionContext {
  if (
    !context ||
    typeof context !== 'object' ||
    !issuedToolSurfaceExecutionContexts.has(context as ToolSurfaceExecutionContext)
  ) {
    throw new ToolSurfaceError(
      'Tool Surface execution context was not issued by the request-scoped builder.',
      'invalid_definition'
    )
  }
}

export function assertActiveToolSurfaceExecutionContext(
  context: unknown,
  expectedRequest: ToolSurfaceRequestIdentity
): asserts context is ToolSurfaceExecutionContext {
  assertIssuedToolSurfaceExecutionContext(context)
  const issuedContext = context as IssuedToolSurfaceExecutionContext
  if (
    !issuedContext[TOOL_SURFACE_EXECUTION_CONTEXT_ACTIVE]() ||
    context.snapshot.request.sessionId !== expectedRequest.sessionId ||
    context.snapshot.request.messageId !== expectedRequest.messageId ||
    context.snapshot.request.runId !== expectedRequest.runId ||
    context.snapshot.request.requestSeq !== expectedRequest.requestSeq
  ) {
    throw new ToolSurfaceError(
      'Tool Surface execution context is stale or does not match the active provider View.',
      'invalid_definition'
    )
  }
}

export interface ToolSurfaceShadowDecision {
  readonly policyVersion: string
  readonly virtualizationTriggered: boolean
  readonly triggerReason: ToolSurfaceShadowTriggerReason
  readonly ceilingToolCount: number
  readonly ceilingDefinitionTokens: number
  readonly eligibleToolCount: number
  readonly eligibleDefinitionTokens: number
  readonly hypotheticalActiveToolCount: number
  readonly hypotheticalActiveDefinitionTokens: number
  readonly hypotheticalAdditionalPromptTokens: number
  /** Signed schema-and-prompt estimate; not provider cache savings or billed cost. */
  readonly estimatedNetInputTokenReduction: number
  readonly toolSearchIncluded: boolean
  readonly initialBudgetFits: boolean
  readonly selectedEntries: readonly ToolSurfaceShadowSelectionEntry[]
  readonly degradationCodes: readonly ToolSurfaceShadowDegradationCode[]
}

export interface ToolSurfaceStaticDefinitionOverlap {
  readonly previousCount: number
  readonly currentCount: number
  readonly retainedCount: number
  readonly unionCount: number
  readonly jaccardRatio: number
}

type JsonTraversalItem =
  | {
      readonly kind: 'enter'
      readonly value: unknown
      readonly depth: number
      readonly label: string
    }
  | { readonly kind: 'exit'; readonly value: object }

interface CanonicalInputBudget {
  readonly maxBytes: number
  readonly maxNodes: number
}

interface CanonicalInputMeasurement {
  readonly bytes: number
  readonly nodes: number
}

interface BuiltCatalogEntry {
  readonly entry: CanonicalToolCatalogEntry
  readonly definition: MCPToolDefinition
  readonly input: CanonicalInputMeasurement
}

interface BuiltCanonicalToolCatalog {
  readonly catalog: CanonicalToolCatalog
  readonly definitionByStableTarget: ReadonlyMap<string, MCPToolDefinition>
}

function failInvalidDefinition(message: string): never {
  throw new ToolSurfaceError(message, 'invalid_definition')
}

function encodedJsonBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function addCanonicalBytes(
  current: number,
  added: number,
  label: string,
  budget: CanonicalInputBudget
): number {
  const next = current + added
  if (next > MAX_TOOL_SURFACE_DEFINITION_BYTES || next > budget.maxBytes) {
    throw new ToolSurfaceError(
      `${label} exceeds the bounded canonical input byte budget.`,
      'limit_exceeded'
    )
  }
  return next
}

function measureBoundedCanonicalInput(
  value: unknown,
  label: string,
  budget: CanonicalInputBudget
): CanonicalInputMeasurement {
  const ancestors = new Set<object>()
  const stack: JsonTraversalItem[] = [{ kind: 'enter', value, depth: 0, label }]
  let nodes = 0
  let bytes = 0

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) break
    if (item.kind === 'exit') {
      ancestors.delete(item.value)
      continue
    }

    nodes += 1
    if (nodes > MAX_TOOL_SURFACE_DEFINITION_NODES || nodes > budget.maxNodes) {
      throw new ToolSurfaceError(
        `${label} exceeds the bounded canonical input node budget.`,
        'limit_exceeded'
      )
    }
    if (item.depth > MAX_TOOL_SURFACE_DEFINITION_DEPTH) {
      throw new ToolSurfaceError(
        `${label} exceeds canonical input depth ${MAX_TOOL_SURFACE_DEFINITION_DEPTH}.`,
        'limit_exceeded'
      )
    }

    if (item.value === null) {
      bytes = addCanonicalBytes(bytes, 4, label, budget)
      continue
    }
    if (typeof item.value === 'boolean') {
      bytes = addCanonicalBytes(bytes, item.value ? 4 : 5, label, budget)
      continue
    }
    if (typeof item.value === 'string') {
      bytes = addCanonicalBytes(bytes, encodedJsonBytes(item.value), label, budget)
      continue
    }
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) failInvalidDefinition(`${item.label} is not finite.`)
      bytes = addCanonicalBytes(bytes, Buffer.byteLength(JSON.stringify(item.value)), label, budget)
      continue
    }
    if (!item.value || typeof item.value !== 'object') {
      failInvalidDefinition(`${item.label} contains a non-JSON value.`)
    }
    if (ancestors.has(item.value)) {
      failInvalidDefinition(`${item.label} contains a circular reference.`)
    }
    if (nodeTypes.isProxy(item.value)) {
      failInvalidDefinition(`${item.label} contains a Proxy object.`)
    }
    if (Object.getOwnPropertySymbols(item.value).length > 0) {
      failInvalidDefinition(`${item.label} contains a symbol property.`)
    }

    ancestors.add(item.value)
    stack.push({ kind: 'exit', value: item.value })

    if (Array.isArray(item.value)) {
      const keys = Object.getOwnPropertyNames(item.value).filter((key) => key !== 'length')
      if (keys.length !== item.value.length) {
        failInvalidDefinition(`${item.label} contains a sparse array or non-index property.`)
      }
      bytes = addCanonicalBytes(bytes, 2 + Math.max(0, item.value.length - 1), label, budget)
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item.value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          failInvalidDefinition(`${item.label}[${index}] is not an enumerable data property.`)
        }
        stack.push({
          kind: 'enter',
          value: descriptor.value,
          depth: item.depth + 1,
          label: `${item.label}[${index}]`
        })
      }
      continue
    }

    const prototype = Object.getPrototypeOf(item.value)
    if (prototype !== Object.prototype && prototype !== null) {
      failInvalidDefinition(`${item.label} contains a non-plain object.`)
    }
    const keys = Object.getOwnPropertyNames(item.value).sort()
    let includedProperties = 0
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        failInvalidDefinition(`${item.label} contains a non-enumerable or accessor property.`)
      }
      if (descriptor.value === undefined) continue
      bytes = addCanonicalBytes(
        bytes,
        encodedJsonBytes(key) + 1 + (includedProperties > 0 ? 1 : 0),
        label,
        budget
      )
      includedProperties += 1
      stack.push({
        kind: 'enter',
        value: descriptor.value,
        depth: item.depth + 1,
        label: `${item.label} property`
      })
    }
    bytes = addCanonicalBytes(bytes, 2, label, budget)
  }

  return { bytes, nodes }
}

function resolveModelExposure(
  definition: MCPToolDefinition
): CanonicalToolCatalogEntry['exposure'] {
  if (definition.source === 'mcp') return 'user-configurable'
  const exposure = getAgentToolExposure(definition.function.name)
  if (exposure === 'diagnostic' || exposure === 'runtime-only') {
    throw new ToolSurfaceError('Tool definition has non-model exposure.', 'ineligible_exposure')
  }
  return exposure
}

function buildCatalogEntry(
  definition: MCPToolDefinition,
  index: number,
  budget: CanonicalInputBudget
): BuiltCatalogEntry {
  const label = `tools[${index}]`
  const input = measureBoundedCanonicalInput(definition, label, budget)

  try {
    const detachedDefinition = JSON.parse(
      canonicalJsonStringifyData(definition, CANONICAL_JSON_OPTIONS)
    ) as MCPToolDefinition
    const baseDefinition = stripToolExecutionContract(detachedDefinition)
    const serialized = canonicalJsonStringifyData(baseDefinition, CANONICAL_JSON_OPTIONS)
    const canonicalDefinitionBytes = Buffer.byteLength(serialized, 'utf8')
    if (canonicalDefinitionBytes > MAX_TOOL_SURFACE_DEFINITION_BYTES) {
      throw new ToolSurfaceError(
        `${label} exceeds ${MAX_TOOL_SURFACE_DEFINITION_BYTES} canonical bytes.`,
        'limit_exceeded'
      )
    }

    const target: DeepChatExecutionToolTargetIdentity =
      buildExecutionToolCeiling(detachedDefinition).target
    return {
      entry: {
        target,
        stableTargetKey: buildExecutionToolTargetKey(target),
        canonicalToolDefinitionHash: buildProviderVisibleToolDefinitionsHash([detachedDefinition]),
        exposure: resolveModelExposure(detachedDefinition),
        execution: detachedDefinition.execution,
        definitionTokens: estimateToolDefinitionTokens([detachedDefinition]),
        canonicalDefinitionBytes
      },
      definition: detachedDefinition,
      input
    }
  } catch (error) {
    if (error instanceof ToolSurfaceError) throw error
    throw new ToolSurfaceError(`${label} is not a canonical Tool definition.`, 'invalid_definition')
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isSafeSumAtMost(left: number, right: number, maximum: number): boolean {
  const sum = left + right
  return Number.isSafeInteger(sum) && sum <= maximum
}

function isValidShadowPolicy(policy: ToolSurfaceShadowPolicy): boolean {
  return (
    policy.policyVersion.trim().length > 0 &&
    isNonNegativeInteger(policy.enterToolCount) &&
    isNonNegativeInteger(policy.exitToolCount) &&
    policy.exitToolCount < policy.enterToolCount &&
    isNonNegativeInteger(policy.enterEstimatedInputTokens) &&
    isNonNegativeInteger(policy.exitEstimatedInputTokens) &&
    policy.exitEstimatedInputTokens < policy.enterEstimatedInputTokens &&
    isNonNegativeInteger(policy.maxInitialToolCount) &&
    isNonNegativeInteger(policy.maxInitialDefinitionTokens) &&
    isNonNegativeInteger(policy.activationReserveToolCount) &&
    policy.activationReserveToolCount <= policy.maxInitialToolCount &&
    isNonNegativeInteger(policy.activationReserveDefinitionTokens) &&
    policy.activationReserveDefinitionTokens <= policy.maxInitialDefinitionTokens &&
    isNonNegativeInteger(policy.maxActivationCandidatesPerBatch) &&
    isNonNegativeInteger(policy.maxActivationCandidateDefinitionTokensPerBatch) &&
    isNonNegativeInteger(policy.maxActivationBatchesPerRun) &&
    policy.maxActivationBatchesPerRun <= MAX_TOOL_SURFACE_CANDIDATE_BATCHES &&
    isNonNegativeInteger(policy.maxAppendedTargetsPerRun) &&
    policy.maxActivationCandidatesPerBatch <= MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES &&
    policy.maxAppendedTargetsPerRun <= MAX_TOOL_SURFACE_DEFINITIONS &&
    isNonNegativeInteger(policy.toolSearchDefinitionTokens) &&
    isNonNegativeInteger(policy.toolSearchPromptTokens) &&
    isSafeSumAtMost(
      policy.toolSearchDefinitionTokens,
      policy.toolSearchPromptTokens,
      Number.MAX_SAFE_INTEGER
    ) &&
    isSafeSumAtMost(1, policy.activationReserveToolCount, policy.maxInitialToolCount) &&
    isSafeSumAtMost(
      policy.toolSearchDefinitionTokens,
      policy.activationReserveDefinitionTokens,
      policy.maxInitialDefinitionTokens
    )
  )
}

function resolveShadowTrigger(
  policy: ToolSurfaceShadowPolicy,
  ceilingToolCount: number,
  ceilingDefinitionTokens: number,
  previouslyVirtualized: boolean
): {
  virtualizationTriggered: boolean
  triggerReason: ToolSurfaceShadowTriggerReason
} {
  const measuredToolCount = ceilingToolCount + 1
  const measuredDefinitionTokens =
    ceilingDefinitionTokens + policy.toolSearchDefinitionTokens + policy.toolSearchPromptTokens
  const countExceeded = measuredToolCount > policy.enterToolCount
  const tokensExceeded = measuredDefinitionTokens > policy.enterEstimatedInputTokens

  if (countExceeded || tokensExceeded) {
    return {
      virtualizationTriggered: true,
      triggerReason:
        countExceeded && tokensExceeded
          ? 'tool-count-and-estimated-input-tokens'
          : countExceeded
            ? 'tool-count'
            : 'estimated-input-tokens'
    }
  }

  if (
    previouslyVirtualized &&
    (measuredToolCount > policy.exitToolCount ||
      measuredDefinitionTokens > policy.exitEstimatedInputTokens)
  ) {
    return { virtualizationTriggered: true, triggerReason: 'hysteresis' }
  }

  return { virtualizationTriggered: false, triggerReason: 'none' }
}

function sortedUniqueKeys(keys: readonly string[]): string[] | null {
  if (keys.length > MAX_TOOL_SURFACE_SELECTION_HINTS) return null
  const unique = new Set<string>()
  let inputBytes = 0
  for (const key of keys) {
    if (key.length > MAX_TOOL_SURFACE_DEFINITION_BYTES) return null
    if (key.trim().length === 0) continue
    inputBytes += Buffer.byteLength(key, 'utf8')
    if (inputBytes > MAX_TOOL_SURFACE_HINT_INPUT_BYTES) return null
    unique.add(key)
  }
  return [...unique].sort(compareCodePoints)
}

function orderedUniqueKeys(keys: readonly string[]): string[] | null {
  if (keys.length > MAX_TOOL_SURFACE_SELECTION_HINTS) return null
  const unique: string[] = []
  const seen = new Set<string>()
  let inputBytes = 0
  for (const key of keys) {
    if (key.length > MAX_TOOL_SURFACE_DEFINITION_BYTES) return null
    if (key.trim().length === 0) continue
    inputBytes += Buffer.byteLength(key, 'utf8')
    if (inputBytes > MAX_TOOL_SURFACE_HINT_INPUT_BYTES) return null
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }
  return unique
}

function hasBoundedDefinitionIdentities(
  identities: readonly ToolSurfaceDefinitionIdentity[]
): boolean {
  let inputBytes = 0
  for (const identity of identities) {
    if (
      typeof identity?.stableTargetKey !== 'string' ||
      typeof identity.canonicalToolDefinitionHash !== 'string' ||
      identity.stableTargetKey.length > MAX_TOOL_SURFACE_DEFINITION_BYTES ||
      identity.canonicalToolDefinitionHash.length > 256
    ) {
      return false
    }
    inputBytes +=
      Buffer.byteLength(identity.stableTargetKey, 'utf8') +
      Buffer.byteLength(identity.canonicalToolDefinitionHash, 'utf8')
    if (inputBytes > MAX_TOOL_SURFACE_HINT_INPUT_BYTES) return false
  }
  return true
}

function hasCanonicalDefinitionIdentity(identity: ToolSurfaceDefinitionIdentity): boolean {
  return (
    identity.stableTargetKey.length > 0 &&
    identity.stableTargetKey === identity.stableTargetKey.trim() &&
    !identity.stableTargetKey.includes('\0') &&
    /^[0-9a-f]{64}$/.test(identity.canonicalToolDefinitionHash)
  )
}

function isBoundedRequestIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_TOOL_SURFACE_REQUEST_ID_BYTES
  )
}

function compareSafeIntegers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareActivationCandidateOrder(
  left: ToolSurfaceActivationCandidate,
  right: ToolSurfaceActivationCandidate
): number {
  return (
    compareSafeIntegers(left.requestSeq, right.requestSeq) ||
    compareSafeIntegers(left.toolCallOrdinalWithinBatch, right.toolCallOrdinalWithinBatch) ||
    compareSafeIntegers(left.resultRank, right.resultRank) ||
    compareCodePoints(left.stableTargetKey, right.stableTargetKey)
  )
}

function requireBoundedDefinitionIdentities(
  identities: readonly ToolSurfaceDefinitionIdentity[],
  label: string,
  maxIdentities = MAX_TOOL_SURFACE_DEFINITIONS
): void {
  if (identities.length > maxIdentities || !hasBoundedDefinitionIdentities(identities)) {
    throw new ToolSurfaceError(`${label} exceeds its bounded identity limit.`, 'limit_exceeded')
  }
  if (!identities.every(hasCanonicalDefinitionIdentity)) {
    throw new ToolSurfaceError(`${label} contains an invalid canonical identity.`, 'invalid_definition')
  }
}

function copyDefinitionIdentity(
  identity: ToolSurfaceDefinitionIdentity
): ToolSurfaceDefinitionIdentity {
  return {
    stableTargetKey: identity.stableTargetKey,
    canonicalToolDefinitionHash: identity.canonicalToolDefinitionHash
  }
}

function requirePlainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new ToolSurfaceError(`${label} must be a plain data object.`, 'invalid_definition')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolSurfaceError(`${label} must be a plain data object.`, 'invalid_definition')
  }
  return value as Record<string, unknown>
}

function readOwnDataProperty(
  value: object,
  key: string,
  label: string,
  required = true
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) {
    if (!required) return undefined
    throw new ToolSurfaceError(`${label}.${key} is missing.`, 'invalid_definition')
  }
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new ToolSurfaceError(`${label}.${key} must be an enumerable data property.`, 'invalid_definition')
  }
  return descriptor.value
}

function readDataArray(value: unknown, label: string, maxLength: number): readonly unknown[] {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || !Array.isArray(value)) {
    throw new ToolSurfaceError(`${label} must be a data array.`, 'invalid_definition')
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new ToolSurfaceError(`${label} has an invalid length.`, 'invalid_definition')
  }
  if (lengthDescriptor.value > maxLength) {
    throw new ToolSurfaceError(`${label} exceeds its bounded limit.`, 'limit_exceeded')
  }
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).filter((key) => key !== 'length').length !==
      lengthDescriptor.value
  ) {
    throw new ToolSurfaceError(`${label} contains non-index data.`, 'invalid_definition')
  }
  const entries: unknown[] = []
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    entries.push(readOwnDataProperty(value, String(index), label))
  }
  return entries
}

function copyActivationCandidate(candidate: unknown): ToolSurfaceActivationCandidate {
  const value = requirePlainDataRecord(candidate, 'Tool Surface activation candidate')
  const stableTargetKey = readOwnDataProperty(
    value,
    'stableTargetKey',
    'Tool Surface activation candidate'
  )
  const canonicalToolDefinitionHash = readOwnDataProperty(
    value,
    'canonicalToolDefinitionHash',
    'Tool Surface activation candidate'
  )
  const sessionId = readOwnDataProperty(value, 'sessionId', 'Tool Surface activation candidate')
  const messageId = readOwnDataProperty(value, 'messageId', 'Tool Surface activation candidate')
  const runId = readOwnDataProperty(value, 'runId', 'Tool Surface activation candidate')
  const requestSeq = readOwnDataProperty(value, 'requestSeq', 'Tool Surface activation candidate')
  const toolCallOrdinalWithinBatch = readOwnDataProperty(
    value,
    'toolCallOrdinalWithinBatch',
    'Tool Surface activation candidate'
  )
  const resultRank = readOwnDataProperty(value, 'resultRank', 'Tool Surface activation candidate')
  if (
    typeof stableTargetKey !== 'string' ||
    typeof canonicalToolDefinitionHash !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof messageId !== 'string' ||
    typeof runId !== 'string' ||
    typeof requestSeq !== 'number' ||
    typeof toolCallOrdinalWithinBatch !== 'number' ||
    typeof resultRank !== 'number'
  ) {
    throw new ToolSurfaceError(
      'Tool Surface activation candidate contains an invalid scalar value.',
      'invalid_definition'
    )
  }
  return {
    stableTargetKey,
    canonicalToolDefinitionHash,
    sessionId,
    messageId,
    runId,
    requestSeq,
    toolCallOrdinalWithinBatch,
    resultRank
  }
}

function readActivationDecision(value: unknown): {
  readonly candidate: ToolSurfaceActivationCandidate
  readonly accepted: unknown
  readonly rejectionCode: unknown
} {
  const decision = requirePlainDataRecord(value, 'Tool Surface activation decision')
  return {
    candidate: copyActivationCandidate(decision),
    accepted: readOwnDataProperty(decision, 'accepted', 'Tool Surface activation decision'),
    rejectionCode: readOwnDataProperty(
      decision,
      'rejectionCode',
      'Tool Surface activation decision',
      false
    )
  }
}

function freezeActivationEntries(
  entries: ToolSurfaceActivationOrderEntry[]
): readonly ToolSurfaceActivationOrderEntry[] {
  for (const entry of entries) Object.freeze(entry)
  return Object.freeze(entries)
}

function freezeActivationLedger(
  entries: ToolSurfaceActivationOrderEntry[]
): ToolSurfaceActivationLedger {
  return Object.freeze({
    orderingVersion: TOOL_SURFACE_ORDERING_VERSION,
    entries: freezeActivationEntries(entries)
  })
}

export function createToolSurfaceActivationLedger(
  initialIdentities: readonly ToolSurfaceDefinitionIdentity[]
): ToolSurfaceActivationLedger {
  requireBoundedDefinitionIdentities(initialIdentities, 'Initial Tool Surface order')
  const hashByTarget = new Map<string, string>()
  const entries: ToolSurfaceActivationOrderEntry[] = []
  for (const identity of initialIdentities) {
    const previousHash = hashByTarget.get(identity.stableTargetKey)
    if (previousHash !== undefined) {
      throw new ToolSurfaceError(
        previousHash === identity.canonicalToolDefinitionHash
          ? 'Initial Tool Surface order contains a duplicate target.'
          : 'Initial Tool Surface order contains conflicting target definitions.',
        'conflicting_tool'
      )
    }
    hashByTarget.set(identity.stableTargetKey, identity.canonicalToolDefinitionHash)
    entries.push({ ...copyDefinitionIdentity(identity), activationOrdinal: entries.length })
  }
  return freezeActivationLedger(entries)
}

function validateActivationLedger(
  ledger: ToolSurfaceActivationLedger
): Map<string, string> {
  if (ledger.orderingVersion !== TOOL_SURFACE_ORDERING_VERSION) {
    throw new ToolSurfaceError(
      'Tool Surface activation ledger uses an unsupported ordering version.',
      'invalid_definition'
    )
  }
  const { entries } = ledger
  requireBoundedDefinitionIdentities(entries, 'Tool Surface activation order')
  const hashByTarget = new Map<string, string>()
  entries.forEach((entry, index) => {
    if (entry.activationOrdinal !== index) {
      throw new ToolSurfaceError(
        'Tool Surface activation ordinals must be contiguous.',
        'invalid_definition'
      )
    }
    const previousHash = hashByTarget.get(entry.stableTargetKey)
    if (previousHash !== undefined) {
      throw new ToolSurfaceError(
        previousHash === entry.canonicalToolDefinitionHash
          ? 'Tool Surface activation order contains a duplicate target.'
          : 'Tool Surface activation order contains conflicting target definitions.',
        'conflicting_tool'
      )
    }
    hashByTarget.set(entry.stableTargetKey, entry.canonicalToolDefinitionHash)
  })
  return hashByTarget
}

export function appendToolSurfaceActivationBatch(
  ledger: ToolSurfaceActivationLedger,
  additions: readonly ToolSurfaceDefinitionIdentity[]
): ToolSurfaceActivationLedger {
  const hashByTarget = validateActivationLedger(ledger)
  const currentEntries = ledger.entries
  requireBoundedDefinitionIdentities(additions, 'Tool Surface activation batch')
  const pendingByTarget = new Map<string, ToolSurfaceDefinitionIdentity>()
  for (const identity of additions) {
    const existingHash = hashByTarget.get(identity.stableTargetKey)
    if (existingHash !== undefined) {
      if (existingHash !== identity.canonicalToolDefinitionHash) {
        throw new ToolSurfaceError(
          'Tool Surface activation batch conflicts with an active target definition.',
          'conflicting_tool'
        )
      }
      continue
    }
    const pending = pendingByTarget.get(identity.stableTargetKey)
    if (pending && pending.canonicalToolDefinitionHash !== identity.canonicalToolDefinitionHash) {
      throw new ToolSurfaceError(
        'Tool Surface activation batch contains conflicting target definitions.',
        'conflicting_tool'
      )
    }
    pendingByTarget.set(identity.stableTargetKey, identity)
  }

  if (currentEntries.length + pendingByTarget.size > MAX_TOOL_SURFACE_DEFINITIONS) {
    throw new ToolSurfaceError(
      'Tool Surface activation order exceeds its definition limit.',
      'limit_exceeded'
    )
  }
  const entries = currentEntries.map((entry) => ({
    ...copyDefinitionIdentity(entry),
    activationOrdinal: entry.activationOrdinal
  }))
  for (const identity of pendingByTarget.values()) {
    entries.push({ ...copyDefinitionIdentity(identity), activationOrdinal: entries.length })
  }
  return freezeActivationLedger(entries)
}

export function projectToolSurfaceActiveEntries(
  ledger: ToolSurfaceActivationLedger,
  eligibleIdentities: readonly ToolSurfaceDefinitionIdentity[]
): readonly ToolSurfaceActivationOrderEntry[] {
  const activeHashByTarget = validateActivationLedger(ledger)
  requireBoundedDefinitionIdentities(eligibleIdentities, 'Eligible Tool Surface projection')
  const eligibleTargets = new Set<string>()
  for (const identity of eligibleIdentities) {
    const activeHash = activeHashByTarget.get(identity.stableTargetKey)
    if (activeHash === undefined) continue
    if (activeHash !== identity.canonicalToolDefinitionHash) {
      throw new ToolSurfaceError(
        'Eligible Tool Surface contains a drifted active target definition.',
        'conflicting_tool'
      )
    }
    eligibleTargets.add(identity.stableTargetKey)
  }
  return freezeActivationEntries(
    ledger.entries
      .filter((entry) => eligibleTargets.has(entry.stableTargetKey))
      .map((entry) => ({
        ...copyDefinitionIdentity(entry),
        activationOrdinal: entry.activationOrdinal
      }))
  )
}

export function mergeToolSurfaceActivationCandidates(
  scope: ToolSurfaceCandidateScope,
  candidateBatches: readonly (readonly ToolSurfaceActivationCandidate[])[]
): readonly ToolSurfaceActivationCandidate[] {
  if (
    !isBoundedRequestIdentity(scope.sessionId) ||
    !isBoundedRequestIdentity(scope.messageId) ||
    !isBoundedRequestIdentity(scope.runId)
  ) {
    throw new ToolSurfaceError('Tool Surface candidate scope is invalid.', 'invalid_definition')
  }
  const batches = readDataArray(
    candidateBatches,
    'Tool Surface activation candidate batches',
    MAX_TOOL_SURFACE_CANDIDATE_BATCHES
  )

  let candidateCount = 0
  const candidates: ToolSurfaceActivationCandidate[] = []
  for (const batchValue of batches) {
    const batch = readDataArray(
      batchValue,
      'Tool Surface activation candidate batch',
      MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES
    )
    candidateCount += batch.length
    if (
      !Number.isSafeInteger(candidateCount) ||
      candidateCount > MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES
    ) {
      throw new ToolSurfaceError(
        'Tool Surface candidate merge exceeds its candidate limit.',
        'limit_exceeded'
      )
    }
    for (const candidate of batch) candidates.push(copyActivationCandidate(candidate))
  }
  requireBoundedDefinitionIdentities(
    candidates,
    'Tool Surface activation candidates',
    MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES
  )

  for (const candidate of candidates) {
    if (
      candidate.sessionId !== scope.sessionId ||
      candidate.messageId !== scope.messageId ||
      candidate.runId !== scope.runId ||
      !Number.isSafeInteger(candidate.requestSeq) ||
      candidate.requestSeq <= 0 ||
      !Number.isSafeInteger(candidate.toolCallOrdinalWithinBatch) ||
      candidate.toolCallOrdinalWithinBatch < 0 ||
      !Number.isSafeInteger(candidate.resultRank) ||
      candidate.resultRank < 0
    ) {
      throw new ToolSurfaceError(
        'Tool Surface activation candidate has an invalid origin.',
        'invalid_definition'
      )
    }
  }

  candidates.sort(compareActivationCandidateOrder)
  const merged: ToolSurfaceActivationCandidate[] = []
  const hashByTarget = new Map<string, string>()
  for (const candidate of candidates) {
    const previousHash = hashByTarget.get(candidate.stableTargetKey)
    if (previousHash !== undefined) {
      if (previousHash !== candidate.canonicalToolDefinitionHash) {
        throw new ToolSurfaceError(
          'Tool Surface activation candidates contain conflicting target definitions.',
          'conflicting_tool'
        )
      }
      continue
    }
    hashByTarget.set(candidate.stableTargetKey, candidate.canonicalToolDefinitionHash)
    Object.freeze(candidate)
    merged.push(candidate)
  }
  return Object.freeze(merged)
}

function freezeShadowDecision(decision: ToolSurfaceShadowDecision): ToolSurfaceShadowDecision {
  for (const entry of decision.selectedEntries) Object.freeze(entry)
  Object.freeze(decision.selectedEntries)
  Object.freeze(decision.degradationCodes)
  return Object.freeze(decision)
}

export function computeToolSurfaceShadowDecision(input: {
  readonly ceilingCatalog: CanonicalToolCatalog
  readonly eligibleCatalog: CanonicalToolCatalog
  readonly policy: ToolSurfaceShadowPolicy
  readonly previouslyVirtualized?: boolean
  readonly policyRequiredStableTargetKeys?: readonly string[]
  readonly coreStableTargetKeys?: readonly string[]
  readonly activeSkillRequiredStableTargetKeys?: readonly string[]
  readonly recentHints?: readonly ToolSurfaceDefinitionIdentity[]
}): ToolSurfaceShadowDecision {
  const { ceilingCatalog, eligibleCatalog, policy } = input
  const fallback = (degradationCode: ToolSurfaceShadowDegradationCode): ToolSurfaceShadowDecision =>
    freezeShadowDecision({
      policyVersion: policy.policyVersion,
      virtualizationTriggered: false,
      triggerReason: 'none',
      ceilingToolCount: ceilingCatalog.entries.length,
      ceilingDefinitionTokens: ceilingCatalog.definitionTokens,
      eligibleToolCount: eligibleCatalog.entries.length,
      eligibleDefinitionTokens: eligibleCatalog.definitionTokens,
      hypotheticalActiveToolCount: eligibleCatalog.entries.length,
      hypotheticalActiveDefinitionTokens: eligibleCatalog.definitionTokens,
      hypotheticalAdditionalPromptTokens: 0,
      estimatedNetInputTokenReduction: 0,
      toolSearchIncluded: false,
      initialBudgetFits: false,
      selectedEntries: eligibleCatalog.entries.map((entry) => ({
        stableTargetKey: entry.stableTargetKey,
        definitionTokens: entry.definitionTokens,
        reason: 'full-catalog',
        required: false
      })),
      degradationCodes: [degradationCode]
    })

  if (!isValidShadowPolicy(policy)) {
    return fallback('invalid-policy')
  }

  const ceilingEntryByTarget = new Map(
    ceilingCatalog.entries.map((entry) => [entry.stableTargetKey, entry])
  )
  const eligibleIsWithinCeiling = eligibleCatalog.entries.every((entry) => {
    const ceilingEntry = ceilingEntryByTarget.get(entry.stableTargetKey)
    return (
      ceilingEntry?.canonicalToolDefinitionHash === entry.canonicalToolDefinitionHash &&
      ceilingEntry.exposure === entry.exposure &&
      canonicalJsonStringifyData(ceilingEntry.execution) ===
        canonicalJsonStringifyData(entry.execution)
    )
  })
  if (!eligibleIsWithinCeiling) {
    return fallback('eligible-catalog-invalid')
  }

  const entryByTarget = new Map(
    eligibleCatalog.entries.map((entry) => [entry.stableTargetKey, entry])
  )
  const policyRequiredKeys = sortedUniqueKeys(input.policyRequiredStableTargetKeys ?? [])
  const activeSkillRequiredKeys = sortedUniqueKeys(input.activeSkillRequiredStableTargetKeys ?? [])
  if (policyRequiredKeys === null || activeSkillRequiredKeys === null) {
    return fallback('selection-input-limit-exceeded')
  }
  const requiredKeys = new Set([...policyRequiredKeys, ...activeSkillRequiredKeys])
  const hasMissingMandatoryTarget = [...requiredKeys].some((key) => !entryByTarget.has(key))

  if (
    !Number.isSafeInteger(
      ceilingCatalog.definitionTokens +
        policy.toolSearchDefinitionTokens +
        policy.toolSearchPromptTokens
    )
  ) {
    return fallback('invalid-policy')
  }
  const trigger = resolveShadowTrigger(
    policy,
    ceilingCatalog.entries.length,
    ceilingCatalog.definitionTokens,
    input.previouslyVirtualized === true
  )
  if (!trigger.virtualizationTriggered) {
    return freezeShadowDecision({
      policyVersion: policy.policyVersion,
      ...trigger,
      ceilingToolCount: ceilingCatalog.entries.length,
      ceilingDefinitionTokens: ceilingCatalog.definitionTokens,
      eligibleToolCount: eligibleCatalog.entries.length,
      eligibleDefinitionTokens: eligibleCatalog.definitionTokens,
      hypotheticalActiveToolCount: eligibleCatalog.entries.length,
      hypotheticalActiveDefinitionTokens: eligibleCatalog.definitionTokens,
      hypotheticalAdditionalPromptTokens: 0,
      estimatedNetInputTokenReduction: 0,
      toolSearchIncluded: false,
      initialBudgetFits: !hasMissingMandatoryTarget,
      selectedEntries: eligibleCatalog.entries.map((entry) => ({
        stableTargetKey: entry.stableTargetKey,
        definitionTokens: entry.definitionTokens,
        reason: 'full-catalog',
        required: requiredKeys.has(entry.stableTargetKey)
      })),
      degradationCodes: hasMissingMandatoryTarget ? ['mandatory-target-missing'] : []
    })
  }

  const coreKeys = sortedUniqueKeys(input.coreStableTargetKeys ?? [])
  const recentHints = input.recentHints ?? []
  if (
    coreKeys === null ||
    recentHints.length > MAX_TOOL_SURFACE_SELECTION_HINTS ||
    !hasBoundedDefinitionIdentities(recentHints)
  ) {
    return fallback('selection-input-limit-exceeded')
  }

  const recentKeys = orderedUniqueKeys(
    recentHints
      .filter((hint) => {
        const entry = entryByTarget.get(hint.stableTargetKey)
        return entry?.canonicalToolDefinitionHash === hint.canonicalToolDefinitionHash
      })
      .map((hint) => hint.stableTargetKey)
  )
  if (recentKeys === null) return fallback('selection-input-limit-exceeded')

  const selectedKeys = new Set<string>()
  const degradationCodes = new Set<ToolSurfaceShadowDegradationCode>()
  const maxSelectedToolCount = Math.max(
    0,
    policy.maxInitialToolCount - policy.activationReserveToolCount - 1
  )
  const maxSelectedDefinitionTokens = Math.max(
    0,
    policy.maxInitialDefinitionTokens -
      policy.activationReserveDefinitionTokens -
      policy.toolSearchDefinitionTokens
  )
  let selectedDefinitionTokens = 0

  for (const stableTargetKey of requiredKeys) {
    const entry = entryByTarget.get(stableTargetKey)
    if (!entry) {
      degradationCodes.add('mandatory-target-missing')
      continue
    }
    selectedKeys.add(stableTargetKey)
    selectedDefinitionTokens += entry.definitionTokens
  }
  if (
    selectedKeys.size > maxSelectedToolCount ||
    selectedDefinitionTokens > maxSelectedDefinitionTokens
  ) {
    degradationCodes.add('mandatory-budget-exceeded')
  }

  const appendOptional = (keys: readonly string[]): void => {
    for (const stableTargetKey of keys) {
      if (selectedKeys.has(stableTargetKey)) continue
      const entry = entryByTarget.get(stableTargetKey)
      if (!entry) continue
      const wouldFit =
        selectedKeys.size < maxSelectedToolCount &&
        selectedDefinitionTokens + entry.definitionTokens <= maxSelectedDefinitionTokens
      if (!wouldFit) continue
      selectedKeys.add(stableTargetKey)
      selectedDefinitionTokens += entry.definitionTokens
    }
  }

  appendOptional(coreKeys)
  appendOptional(recentKeys)

  const selectedEntries: ToolSurfaceShadowSelectionEntry[] = []
  const emitted = new Set<string>()
  const emit = (
    keys: readonly string[],
    reason: Exclude<ToolSurfaceSelectionReason, 'full-catalog'>
  ): void => {
    for (const stableTargetKey of keys) {
      if (!selectedKeys.has(stableTargetKey) || emitted.has(stableTargetKey)) continue
      const entry = entryByTarget.get(stableTargetKey)
      if (!entry) continue
      emitted.add(stableTargetKey)
      selectedEntries.push({
        stableTargetKey,
        definitionTokens: entry.definitionTokens,
        reason,
        required: requiredKeys.has(stableTargetKey)
      })
    }
  }
  emit(policyRequiredKeys, 'policy-required')
  emit(coreKeys, 'core')
  emit(activeSkillRequiredKeys, 'active-skill')
  emit(recentKeys, 'recent')

  const hypotheticalActiveDefinitionTokens =
    selectedDefinitionTokens + policy.toolSearchDefinitionTokens
  const hypotheticalActiveToolCount = selectedEntries.length + 1
  const estimatedNetInputTokenReduction =
    eligibleCatalog.definitionTokens -
    hypotheticalActiveDefinitionTokens -
    policy.toolSearchPromptTokens

  return freezeShadowDecision({
    policyVersion: policy.policyVersion,
    ...trigger,
    ceilingToolCount: ceilingCatalog.entries.length,
    ceilingDefinitionTokens: ceilingCatalog.definitionTokens,
    eligibleToolCount: eligibleCatalog.entries.length,
    eligibleDefinitionTokens: eligibleCatalog.definitionTokens,
    hypotheticalActiveToolCount,
    hypotheticalActiveDefinitionTokens,
    hypotheticalAdditionalPromptTokens: policy.toolSearchPromptTokens,
    estimatedNetInputTokenReduction,
    toolSearchIncluded: true,
    initialBudgetFits:
      !degradationCodes.has('mandatory-target-missing') &&
      !degradationCodes.has('mandatory-budget-exceeded') &&
      hypotheticalActiveToolCount + policy.activationReserveToolCount <=
        policy.maxInitialToolCount &&
      hypotheticalActiveDefinitionTokens + policy.activationReserveDefinitionTokens <=
        policy.maxInitialDefinitionTokens,
    selectedEntries,
    degradationCodes: [...degradationCodes].sort(compareCodePoints)
  })
}

function definitionIdentityKey(identity: ToolSurfaceDefinitionIdentity): string {
  return JSON.stringify([identity.stableTargetKey, identity.canonicalToolDefinitionHash])
}

export function computeToolSurfaceStaticDefinitionOverlap(
  previousIdentities: readonly ToolSurfaceDefinitionIdentity[],
  currentIdentities: readonly ToolSurfaceDefinitionIdentity[]
): ToolSurfaceStaticDefinitionOverlap {
  if (
    previousIdentities.length > MAX_TOOL_SURFACE_OVERLAP_IDENTITIES ||
    currentIdentities.length > MAX_TOOL_SURFACE_OVERLAP_IDENTITIES ||
    !hasBoundedDefinitionIdentities(previousIdentities) ||
    !hasBoundedDefinitionIdentities(currentIdentities)
  ) {
    throw new ToolSurfaceError(
      'Tool Surface overlap input exceeds its bounded limit.',
      'limit_exceeded'
    )
  }
  const previous = new Set(previousIdentities.map(definitionIdentityKey))
  const current = new Set(currentIdentities.map(definitionIdentityKey))
  let retainedCount = 0
  for (const key of previous) {
    if (current.has(key)) retainedCount += 1
  }
  const unionCount = previous.size + current.size - retainedCount
  return Object.freeze({
    previousCount: previous.size,
    currentCount: current.size,
    retainedCount,
    unionCount,
    jaccardRatio: unionCount === 0 ? 1 : retainedCount / unionCount
  })
}

function freezeCatalog(catalog: CanonicalToolCatalog): CanonicalToolCatalog {
  for (const entry of catalog.entries) {
    Object.freeze(entry.target)
    Object.freeze(entry.execution)
    Object.freeze(entry)
  }
  Object.freeze(catalog.entries)
  return Object.freeze(catalog)
}

function deepFreezeToolDefinition(definition: MCPToolDefinition): MCPToolDefinition {
  const pending: object[] = [definition]
  const visited = new Set<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)
    for (const key of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor || !('value' in descriptor)) continue
      const value = descriptor.value
      if (value && typeof value === 'object') pending.push(value)
    }
    Object.freeze(current)
  }
  return definition
}

function buildCanonicalToolCatalogArtifacts(
  definitions: readonly MCPToolDefinition[],
  options: { readonly freezeDefinitions?: boolean } = {}
): BuiltCanonicalToolCatalog {
  if (definitions.length > MAX_TOOL_SURFACE_DEFINITIONS) {
    throw new ToolSurfaceError(
      `Tool catalog has more than ${MAX_TOOL_SURFACE_DEFINITIONS} definitions.`,
      'limit_exceeded'
    )
  }

  const entryByTarget = new Map<string, CanonicalToolCatalogEntry>()
  const definitionByStableTarget = new Map<string, MCPToolDefinition>()
  const targetByVisibleName = new Map<string, string>()
  let canonicalDefinitionBytes = 0
  let inputBytes = 0
  let inputNodes = 0

  definitions.forEach((definition, index) => {
    const built = buildCatalogEntry(definition, index, {
      maxBytes: MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES - inputBytes,
      maxNodes: MAX_TOOL_SURFACE_TOTAL_INPUT_NODES - inputNodes
    })
    inputBytes += built.input.bytes
    inputNodes += built.input.nodes
    const { entry } = built
    const visibleName = entry.target.providerVisibleName
    const previousTarget = targetByVisibleName.get(visibleName)
    if (previousTarget !== undefined && previousTarget !== entry.stableTargetKey) {
      throw new ToolSurfaceError(
        `${labelFor(index)} resolves to a conflicting target.`,
        'conflicting_tool'
      )
    }
    targetByVisibleName.set(visibleName, entry.stableTargetKey)

    const previous = entryByTarget.get(entry.stableTargetKey)
    if (previous) {
      if (
        previous.canonicalToolDefinitionHash !== entry.canonicalToolDefinitionHash ||
        canonicalJsonStringifyData(previous.execution) !==
          canonicalJsonStringifyData(entry.execution) ||
        previous.exposure !== entry.exposure
      ) {
        throw new ToolSurfaceError(
          `${labelFor(index)} conflicts with a prior definition.`,
          'conflicting_tool'
        )
      }
      return
    }

    canonicalDefinitionBytes += entry.canonicalDefinitionBytes
    if (canonicalDefinitionBytes > MAX_TOOL_SURFACE_TOTAL_DEFINITION_BYTES) {
      throw new ToolSurfaceError(
        `Tool catalog exceeds ${MAX_TOOL_SURFACE_TOTAL_DEFINITION_BYTES} canonical bytes.`,
        'limit_exceeded'
      )
    }
    entryByTarget.set(entry.stableTargetKey, entry)
    definitionByStableTarget.set(
      entry.stableTargetKey,
      options.freezeDefinitions ? deepFreezeToolDefinition(built.definition) : built.definition
    )
  })

  const entries = [...entryByTarget.values()].sort((left, right) =>
    compareCodePoints(left.stableTargetKey, right.stableTargetKey)
  )
  const fullCatalogHash = hashJsonData(
    {
      schemaVersion: TOOL_SURFACE_CATALOG_SCHEMA_VERSION,
      canonicalizationVersion: TOOL_SURFACE_CANONICALIZATION_VERSION,
      entries: entries.map((entry) => ({
        target: entry.target,
        canonicalToolDefinitionHash: entry.canonicalToolDefinitionHash,
        exposure: entry.exposure,
        execution: entry.execution
      }))
    },
    CANONICAL_JSON_OPTIONS
  )

  return Object.freeze({
    catalog: freezeCatalog({
      schemaVersion: TOOL_SURFACE_CATALOG_SCHEMA_VERSION,
      canonicalizationVersion: TOOL_SURFACE_CANONICALIZATION_VERSION,
      fullCatalogHash,
      entries,
      definitionTokens: entries.reduce((total, entry) => total + entry.definitionTokens, 0),
      canonicalDefinitionBytes
    }),
    definitionByStableTarget
  })
}

export function buildCanonicalToolCatalog(
  definitions: readonly MCPToolDefinition[]
): CanonicalToolCatalog {
  return buildCanonicalToolCatalogArtifacts(definitions).catalog
}

export function buildToolSurfaceRunCeiling(
  definitions: readonly MCPToolDefinition[]
): ToolSurfaceRunCeiling {
  const built = buildCanonicalToolCatalogArtifacts(definitions, { freezeDefinitions: true })
  const entries = built.catalog.entries.map((catalogEntry) => {
    const definition = built.definitionByStableTarget.get(catalogEntry.stableTargetKey)
    if (!definition) {
      throw new ToolSurfaceError(
        'Run Tool Ceiling lost a canonical definition.',
        'invalid_definition'
      )
    }
    return Object.freeze({ catalogEntry, definition })
  })
  const ceiling = Object.freeze({
    catalog: built.catalog,
    entries: Object.freeze(entries)
  })
  issuedRunToolCeilings.add(ceiling)
  return ceiling
}

function createProviderOrderedActivationLedgerFromCatalog(
  catalog: CanonicalToolCatalog,
  definitions: readonly MCPToolDefinition[]
): ToolSurfaceActivationLedger {
  const entryByVisibleName = new Map(
    catalog.entries.map((entry) => [entry.target.providerVisibleName, entry])
  )
  const emittedTargets = new Set<string>()
  const identities: ToolSurfaceDefinitionIdentity[] = []
  for (const definition of definitions) {
    const entry = entryByVisibleName.get(definition.function.name)
    if (!entry || emittedTargets.has(entry.stableTargetKey)) continue
    emittedTargets.add(entry.stableTargetKey)
    identities.push(copyDefinitionIdentity(entry))
  }
  return createToolSurfaceActivationLedger(identities)
}

export function createProviderOrderedToolSurfaceActivationLedger(
  definitions: readonly MCPToolDefinition[]
): ToolSurfaceActivationLedger {
  const built = buildCanonicalToolCatalogArtifacts(definitions)
  return createProviderOrderedActivationLedgerFromCatalog(built.catalog, definitions)
}

function validateToolSurfaceRunCeiling(ceiling: ToolSurfaceRunCeiling): void {
  if (
    !ceiling ||
    typeof ceiling !== 'object' ||
    !issuedRunToolCeilings.has(ceiling)
  ) {
    throw new ToolSurfaceError(
      'Run Tool Ceiling was not issued by the canonical builder.',
      'invalid_definition'
    )
  }
}

function isToolSurfaceSelectionReason(value: unknown): value is ToolSurfaceSelectionReason {
  return (
    typeof value === 'string' &&
    (TOOL_SURFACE_SELECTION_REASONS as readonly string[]).includes(value)
  )
}

function isToolSurfaceActivationRejectionCode(
  value: unknown
): value is ToolSurfaceActivationRejectionCode {
  return (
    typeof value === 'string' &&
    (TOOL_SURFACE_ACTIVATION_REJECTION_CODES as readonly string[]).includes(value)
  )
}

function catalogEntryMatches(
  left: CanonicalToolCatalogEntry,
  right: CanonicalToolCatalogEntry
): boolean {
  return (
    left.canonicalToolDefinitionHash === right.canonicalToolDefinitionHash &&
    left.exposure === right.exposure &&
    canonicalJsonStringifyData(left.execution) === canonicalJsonStringifyData(right.execution)
  )
}

function isToolSearchCatalogEntry(entry: CanonicalToolCatalogEntry): boolean {
  return (
    entry.target.source === 'agent' &&
    entry.target.providerVisibleName === TOOL_SEARCH_AGENT_TOOL_NAME &&
    entry.target.originalName === TOOL_SEARCH_AGENT_TOOL_NAME &&
    entry.target.serverName === TOOL_SEARCH_AGENT_TOOL_SERVER_NAME &&
    entry.target.serverId === null &&
    entry.target.configGeneration === null &&
    entry.target.bindingHash === null &&
    entry.exposure === 'system-model' &&
    entry.execution.effect === 'read' &&
    entry.execution.mode === 'parallel'
  )
}

export function createToolSurfaceSnapshot(input: {
  readonly request: ToolSurfaceRequestIdentity
  readonly policyVersion: string
  readonly virtualizationTriggered: boolean
  readonly ceiling: ToolSurfaceRunCeiling
  readonly eligibleDefinitions: readonly MCPToolDefinition[]
  readonly activationLedger: ToolSurfaceActivationLedger
  readonly selectionReasons?: readonly {
    readonly stableTargetKey: string
    readonly reason: ToolSurfaceSelectionReason
  }[]
  readonly activation?: ToolSurfaceSnapshotActivation
}): ToolSurfaceSnapshot {
  if (
    !input ||
    typeof input !== 'object' ||
    !input.request ||
    typeof input.request !== 'object' ||
    !Array.isArray(input.eligibleDefinitions) ||
    !input.activationLedger ||
    typeof input.activationLedger !== 'object' ||
    !Array.isArray(input.activationLedger.entries) ||
    (input.selectionReasons !== undefined && !Array.isArray(input.selectionReasons)) ||
    (input.activation !== undefined &&
      (!input.activation || typeof input.activation !== 'object'))
  ) {
    throw new ToolSurfaceError('Tool Surface snapshot input is invalid.', 'invalid_definition')
  }
  const { request } = input
  if (
    !isBoundedRequestIdentity(request.sessionId) ||
    !isBoundedRequestIdentity(request.messageId) ||
    !isBoundedRequestIdentity(request.runId) ||
    !Number.isSafeInteger(request.requestSeq) ||
    request.requestSeq <= 0 ||
    !isBoundedRequestIdentity(input.policyVersion) ||
    typeof input.virtualizationTriggered !== 'boolean'
  ) {
    throw new ToolSurfaceError('Tool Surface snapshot identity is invalid.', 'invalid_definition')
  }
  validateToolSurfaceRunCeiling(input.ceiling)

  const ceilingEntryByTarget = new Map(
    input.ceiling.catalog.entries.map((entry) => [entry.stableTargetKey, entry])
  )
  const activeHashByTarget = validateActivationLedger(input.activationLedger)
  for (const ledgerEntry of input.activationLedger.entries) {
    const ceilingEntry = ceilingEntryByTarget.get(ledgerEntry.stableTargetKey)
    if (
      !ceilingEntry ||
      ceilingEntry.canonicalToolDefinitionHash !== ledgerEntry.canonicalToolDefinitionHash
    ) {
      throw new ToolSurfaceError(
        'Tool Surface activation order is outside the Run Tool Ceiling.',
        'conflicting_tool'
      )
    }
  }

  const eligible = buildCanonicalToolCatalogArtifacts(input.eligibleDefinitions, {
    freezeDefinitions: true
  })
  for (const eligibleEntry of eligible.catalog.entries) {
    const ceilingEntry = ceilingEntryByTarget.get(eligibleEntry.stableTargetKey)
    if (!ceilingEntry || !catalogEntryMatches(ceilingEntry, eligibleEntry)) {
      throw new ToolSurfaceError(
        'Eligible Tool Surface is outside the Run Tool Ceiling.',
        'conflicting_tool'
      )
    }
  }

  const reasonByTarget = new Map<string, ToolSurfaceSelectionReason>()
  const selectionReasons = input.selectionReasons ?? []
  if (selectionReasons.length > MAX_TOOL_SURFACE_DEFINITIONS) {
    throw new ToolSurfaceError('Tool Surface selection reasons exceed their limit.', 'limit_exceeded')
  }
  for (const selection of selectionReasons) {
    if (
      !selection ||
      typeof selection !== 'object' ||
      typeof selection.stableTargetKey !== 'string' ||
      !ceilingEntryByTarget.has(selection.stableTargetKey) ||
      !isToolSurfaceSelectionReason(selection.reason)
    ) {
      throw new ToolSurfaceError(
        'Tool Surface selection reason is invalid.',
        'invalid_definition'
      )
    }
    const previous = reasonByTarget.get(selection.stableTargetKey)
    if (previous && previous !== selection.reason) {
      throw new ToolSurfaceError(
        'Tool Surface selection reasons conflict for one target.',
        'conflicting_tool'
      )
    }
    const ceilingEntry = ceilingEntryByTarget.get(selection.stableTargetKey)
    const identifiesToolSearch = ceilingEntry ? isToolSearchCatalogEntry(ceilingEntry) : false
    if (
      (selection.reason === 'tool-search' &&
        (!input.virtualizationTriggered || !identifiesToolSearch)) ||
      (selection.reason !== 'tool-search' && identifiesToolSearch)
    ) {
      throw new ToolSurfaceError(
        'Tool Surface ToolSearch selection provenance is invalid.',
        'invalid_definition'
      )
    }
    reasonByTarget.set(selection.stableTargetKey, selection.reason)
  }

  const projected = projectToolSurfaceActiveEntries(
    input.activationLedger,
    eligible.catalog.entries
  )
  if (!input.virtualizationTriggered && projected.length !== eligible.catalog.entries.length) {
    throw new ToolSurfaceError(
      'A non-virtualized Tool Surface must expose every eligible target.',
      'invalid_definition'
    )
  }
  const projectedTargets = new Set(projected.map((entry) => entry.stableTargetKey))
  if (
    !input.virtualizationTriggered &&
    projected.some((entry) => {
      const ceilingEntry = ceilingEntryByTarget.get(entry.stableTargetKey)
      return ceilingEntry ? isToolSearchCatalogEntry(ceilingEntry) : false
    })
  ) {
    throw new ToolSurfaceError(
      'A non-virtualized Tool Surface cannot expose ToolSearch.',
      'invalid_definition'
    )
  }
  if (selectionReasons.some((selection) => !projectedTargets.has(selection.stableTargetKey))) {
    throw new ToolSurfaceError(
      'Tool Surface selection reason does not describe an active target.',
      'invalid_definition'
    )
  }
  if (
    input.virtualizationTriggered &&
    projected.some((entry) => !reasonByTarget.has(entry.stableTargetKey))
  ) {
    throw new ToolSurfaceError(
      'A virtualized Tool Surface requires a reason for every active target.',
      'invalid_definition'
    )
  }

  let activationOriginRequestSeq: unknown = null
  let activationDecisionInputs: readonly unknown[] = []
  if (input.activation !== undefined) {
    const activationInput = requirePlainDataRecord(
      input.activation,
      'Tool Surface activation provenance'
    )
    activationOriginRequestSeq = readOwnDataProperty(
      activationInput,
      'originRequestSeq',
      'Tool Surface activation provenance'
    )
    activationDecisionInputs = readDataArray(
      readOwnDataProperty(activationInput, 'decisions', 'Tool Surface activation provenance'),
      'Tool Surface activation decisions',
      MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES
    )
  }
  if (
    (!input.virtualizationTriggered &&
      (activationOriginRequestSeq !== null || activationDecisionInputs.length > 0)) ||
    (activationDecisionInputs.length === 0 && activationOriginRequestSeq !== null) ||
    (activationDecisionInputs.length > 0 &&
      (typeof activationOriginRequestSeq !== 'number' ||
        !Number.isSafeInteger(activationOriginRequestSeq) ||
        activationOriginRequestSeq <= 0 ||
        activationOriginRequestSeq >= request.requestSeq))
  ) {
    throw new ToolSurfaceError(
      'Tool Surface activation provenance has an invalid View origin.',
      'invalid_definition'
    )
  }
  const activationTargets = new Set<string>()
  const activationDecisions: ToolSurfaceActivationDecision[] = []
  let previousActivationCandidate: ToolSurfaceActivationCandidate | null = null
  for (const decisionInput of activationDecisionInputs) {
    const decision = readActivationDecision(decisionInput)
    const candidate = decision.candidate
    const ceilingEntry = ceilingEntryByTarget.get(candidate.stableTargetKey)
    const accepted = decision.accepted
    const rejectionCode = decision.rejectionCode
    if (typeof accepted !== 'boolean') {
      throw new ToolSurfaceError(
        'Tool Surface activation decision is invalid.',
        'invalid_definition'
      )
    }
    let normalizedRejectionCode: ToolSurfaceActivationRejectionCode | undefined
    if (accepted) {
      if (rejectionCode !== undefined) {
        throw new ToolSurfaceError(
          'Tool Surface activation decision is invalid.',
          'invalid_definition'
        )
      }
    } else {
      if (!isToolSurfaceActivationRejectionCode(rejectionCode)) {
        throw new ToolSurfaceError(
          'Tool Surface activation decision is invalid.',
          'invalid_definition'
        )
      }
      normalizedRejectionCode = rejectionCode
    }
    if (
      candidate.sessionId !== request.sessionId ||
      candidate.messageId !== request.messageId ||
      candidate.runId !== request.runId ||
      candidate.requestSeq !== activationOriginRequestSeq ||
      !Number.isSafeInteger(candidate.toolCallOrdinalWithinBatch) ||
      candidate.toolCallOrdinalWithinBatch < 0 ||
      !Number.isSafeInteger(candidate.resultRank) ||
      candidate.resultRank < 0 ||
      !ceilingEntry ||
      ceilingEntry.canonicalToolDefinitionHash !== candidate.canonicalToolDefinitionHash ||
      activationTargets.has(candidate.stableTargetKey) ||
      (previousActivationCandidate !== null &&
        compareActivationCandidateOrder(previousActivationCandidate, candidate) >= 0) ||
      (accepted &&
        (!projectedTargets.has(candidate.stableTargetKey) ||
          reasonByTarget.get(candidate.stableTargetKey) !== 'search-result')) ||
      (!accepted && projectedTargets.has(candidate.stableTargetKey))
    ) {
      throw new ToolSurfaceError(
        'Tool Surface activation decision is invalid.',
        'invalid_definition'
      )
    }
    activationTargets.add(candidate.stableTargetKey)
    previousActivationCandidate = candidate
    activationDecisions.push({
      ...candidate,
      accepted,
      ...(normalizedRejectionCode ? { rejectionCode: normalizedRejectionCode } : {})
    })
  }

  const activeEntries = projected.map((entry): ToolSurfaceSnapshotActiveEntry => {
    const definition = eligible.definitionByStableTarget.get(entry.stableTargetKey)
    if (!definition || activeHashByTarget.get(entry.stableTargetKey) !== entry.canonicalToolDefinitionHash) {
      throw new ToolSurfaceError(
        'Tool Surface snapshot lost an active definition.',
        'invalid_definition'
      )
    }
    return Object.freeze({
      ...entry,
      reason: reasonByTarget.get(entry.stableTargetKey) ?? 'full-catalog',
      definition
    })
  })
  const toolDefinitions = Object.freeze(activeEntries.map((entry) => entry.definition))
  for (const decision of activationDecisions) Object.freeze(decision)
  const activation = Object.freeze({
    originRequestSeq: activationOriginRequestSeq as number | null,
    decisions: Object.freeze(activationDecisions)
  })
  const snapshot = Object.freeze({
    schemaVersion: TOOL_SURFACE_SNAPSHOT_SCHEMA_VERSION,
    canonicalizationVersion: TOOL_SURFACE_CANONICALIZATION_VERSION,
    orderingVersion: TOOL_SURFACE_ORDERING_VERSION,
    request: Object.freeze({ ...request }),
    policyVersion: input.policyVersion,
    virtualizationTriggered: input.virtualizationTriggered,
    ceiling: input.ceiling,
    eligibleCatalog: eligible.catalog,
    activeEntries: Object.freeze(activeEntries),
    toolDefinitions,
    activation
  })
  issuedToolSurfaceSnapshots.add(snapshot)
  return snapshot
}

export function createFullToolSurfaceRunController(input: {
  readonly ceilingDefinitions: readonly MCPToolDefinition[]
  readonly initialActiveDefinitions: readonly MCPToolDefinition[]
  readonly policyVersion: string
}): FullToolSurfaceRunController {
  const ceiling = buildToolSurfaceRunCeiling(input.ceilingDefinitions)
  const initialCatalog = buildCanonicalToolCatalog(input.initialActiveDefinitions)
  const ceilingEntryByTarget = new Map(
    ceiling.catalog.entries.map((entry) => [entry.stableTargetKey, entry])
  )
  for (const entry of initialCatalog.entries) {
    const ceilingEntry = ceilingEntryByTarget.get(entry.stableTargetKey)
    if (!ceilingEntry || !catalogEntryMatches(ceilingEntry, entry)) {
      throw new ToolSurfaceError(
        'Initial Active Surface is outside the Run Tool Ceiling.',
        'conflicting_tool'
      )
    }
  }
  let admittedLedger = createProviderOrderedActivationLedgerFromCatalog(
    initialCatalog,
    input.initialActiveDefinitions
  )
  const ceilingEntryByVisibleName = new Map(
    ceiling.catalog.entries.map((entry) => [entry.target.providerVisibleName, entry])
  )
  const proposals = new WeakMap<
    ToolSurfaceSnapshot,
    {
      readonly baseLedger: ToolSurfaceActivationLedger
      readonly nextLedger: ToolSurfaceActivationLedger
    }
  >()
  const admittedSnapshots = new WeakSet<ToolSurfaceSnapshot>()

  const controller: FullToolSurfaceRunController = {
    ceiling,
    policyVersion: input.policyVersion,
    virtualizationTriggered: false,
    stageActivationBatch: (candidates) => {
      const candidateBatch = readDataArray(
        candidates,
        'Tool Surface activation candidate batch',
        MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES
      )
      if (candidateBatch.length === 0) return
      throw new ToolSurfaceError(
        'A full Tool Surface does not accept activation candidates.',
        'invalid_definition'
      )
    },
    build: ({ request, eligibleDefinitions }) => {
      buildCanonicalToolCatalog(eligibleDefinitions)
      const eligibleIdentities = eligibleDefinitions.map((definition) => {
        const ceilingEntry = ceilingEntryByVisibleName.get(definition.function.name)
        if (!ceilingEntry) {
          throw new ToolSurfaceError(
            'Eligible Tool Surface is outside the Run Tool Ceiling.',
            'conflicting_tool'
          )
        }
        return copyDefinitionIdentity(ceilingEntry)
      })
      const nextLedger = appendToolSurfaceActivationBatch(admittedLedger, eligibleIdentities)
      const snapshot = createToolSurfaceSnapshot({
        request,
        policyVersion: input.policyVersion,
        virtualizationTriggered: false,
        ceiling,
        eligibleDefinitions,
        activationLedger: nextLedger
      })
      proposals.set(snapshot, { baseLedger: admittedLedger, nextLedger })
      return snapshot
    },
    admit: (snapshot) => {
      assertIssuedToolSurfaceSnapshot(snapshot)
      if (admittedSnapshots.has(snapshot)) return
      const proposal = proposals.get(snapshot)
      if (!proposal) {
        throw new ToolSurfaceError(
          'Tool Surface snapshot was not prepared by this Run controller.',
          'invalid_definition'
        )
      }
      if (proposal.baseLedger !== admittedLedger) {
        throw new ToolSurfaceError(
          'Tool Surface snapshot was prepared from a stale activation ledger.',
          'conflicting_tool'
        )
      }
      admittedLedger = proposal.nextLedger
      proposals.delete(snapshot)
      admittedSnapshots.add(snapshot)
      admittedToolSurfaceSnapshots.add(snapshot)
    }
  }
  return Object.freeze(controller)
}

export function createPolicySelectedToolSurfaceRun(input: {
  readonly ceilingDefinitions: readonly MCPToolDefinition[]
  readonly initialEligibleDefinitions: readonly MCPToolDefinition[]
  readonly toolSearchDefinition: MCPToolDefinition
  readonly policy: ToolSurfaceSelectionPolicy
  readonly previouslyVirtualized?: boolean
  readonly policyRequiredStableTargetKeys?: readonly string[]
  readonly coreStableTargetKeys?: readonly string[]
  readonly activeSkillRequiredStableTargetKeys?: readonly string[]
  readonly recentHints?: readonly ToolSurfaceDefinitionIdentity[]
}): PolicySelectedToolSurfaceRun {
  const baseCeiling = buildToolSurfaceRunCeiling(input.ceilingDefinitions)
  const initialEligibleCatalog = buildCanonicalToolCatalog(input.initialEligibleDefinitions)
  const decision = computeToolSurfaceShadowDecision({
    ceilingCatalog: baseCeiling.catalog,
    eligibleCatalog: initialEligibleCatalog,
    policy: input.policy,
    previouslyVirtualized: input.previouslyVirtualized,
    policyRequiredStableTargetKeys: input.policyRequiredStableTargetKeys,
    coreStableTargetKeys: input.coreStableTargetKeys,
    activeSkillRequiredStableTargetKeys: input.activeSkillRequiredStableTargetKeys,
    recentHints: input.recentHints
  })

  if (decision.degradationCodes.length > 0 || !decision.initialBudgetFits) {
    throw new ToolSurfaceError(
      'Tool Surface selection cannot satisfy the configured initial surface.',
      decision.degradationCodes.includes('mandatory-budget-exceeded')
        ? 'limit_exceeded'
        : 'invalid_definition'
    )
  }
  if (!decision.virtualizationTriggered) {
    return Object.freeze({
      decision,
      controller: createFullToolSurfaceRunController({
        ceilingDefinitions: input.ceilingDefinitions,
        initialActiveDefinitions: input.initialEligibleDefinitions,
        policyVersion: input.policy.policyVersion
      })
    })
  }

  const searchCatalog = buildCanonicalToolCatalog([input.toolSearchDefinition])
  const searchEntry = searchCatalog.entries[0]
  if (
    searchCatalog.entries.length !== 1 ||
    !isToolSearchCatalogEntry(searchEntry) ||
    searchEntry.definitionTokens > input.policy.toolSearchDefinitionTokens
  ) {
    throw new ToolSurfaceError(
      'Tool Surface requires the reserved read-only ToolSearch definition within its budget.',
      'invalid_definition'
    )
  }
  const ceiling = buildToolSurfaceRunCeiling([
    ...input.ceilingDefinitions,
    input.toolSearchDefinition
  ])
  const toolSearchCeilingEntry = ceiling.entries.find(
    (entry) => entry.catalogEntry.stableTargetKey === searchEntry.stableTargetKey
  )
  if (!toolSearchCeilingEntry || !isToolSearchCatalogEntry(toolSearchCeilingEntry.catalogEntry)) {
    throw new ToolSurfaceError(
      'Run Tool Ceiling lost the reserved ToolSearch definition.',
      'invalid_definition'
    )
  }
  const runToolSearchDefinition = toolSearchCeilingEntry.definition
  const initialEntryByTarget = new Map(
    initialEligibleCatalog.entries.map((entry) => [entry.stableTargetKey, entry])
  )
  const selectedIdentities = decision.selectedEntries.map((selection) => {
    const entry = initialEntryByTarget.get(selection.stableTargetKey)
    if (!entry) {
      throw new ToolSurfaceError(
        'Tool Surface selection lost an initial eligible definition.',
        'invalid_definition'
      )
    }
    return copyDefinitionIdentity(entry)
  })
  let admittedLedger = createToolSurfaceActivationLedger([
    ...selectedIdentities,
    copyDefinitionIdentity(searchEntry)
  ])
  const reasonByTarget = new Map<ToolSurfaceDefinitionIdentity['stableTargetKey'], ToolSurfaceSelectionReason>(
    decision.selectedEntries.map((entry) => [entry.stableTargetKey, entry.reason])
  )
  reasonByTarget.set(searchEntry.stableTargetKey, 'tool-search')
  const ceilingEntryByVisibleName = new Map(
    ceiling.catalog.entries.map((entry) => [entry.target.providerVisibleName, entry])
  )
  const ceilingEntryByTarget = new Map(
    ceiling.catalog.entries.map((entry) => [entry.stableTargetKey, entry])
  )
  let latestAdmittedRequest: ToolSurfaceRequestIdentity | null = null
  let pendingCandidates: readonly ToolSurfaceActivationCandidate[] | null = null
  let pendingOriginRequest: ToolSurfaceRequestIdentity | null = null
  let pendingFingerprint: string | null = null
  let admittedActivationBatches = 0
  let admittedAppendedTargets = 0
  const consumedReleaseFingerprintByRequestSeq = new Map<number, string>()
  const proposals = new WeakMap<
    ToolSurfaceSnapshot,
    {
      readonly baseLedger: ToolSurfaceActivationLedger
      readonly nextLedger: ToolSurfaceActivationLedger
      readonly pendingCandidates: readonly ToolSurfaceActivationCandidate[] | null
      readonly pendingFingerprint: string | null
      readonly appendedTargets: number
    }
  >()
  const admittedSnapshots = new WeakSet<ToolSurfaceSnapshot>()
  let latestExecutionEligibleSnapshot: ToolSurfaceSnapshot | null = null

  const controller: FullToolSurfaceRunController = {
    ceiling,
    policyVersion: input.policy.policyVersion,
    virtualizationTriggered: true,
    stageActivationBatch: (candidates) => {
      const candidateBatch = readDataArray(
        candidates,
        'Tool Surface activation candidate batch',
        MAX_TOOL_SURFACE_ACTIVATION_CANDIDATES
      )
      if (candidateBatch.length === 0) return
      if (!latestAdmittedRequest) {
        throw new ToolSurfaceError(
          'Activation candidates require an admitted originating View.',
          'invalid_definition'
        )
      }
      const origin = latestAdmittedRequest
      const merged = mergeToolSurfaceActivationCandidates(origin, [
        candidateBatch as readonly ToolSurfaceActivationCandidate[]
      ])
      const originRequestSeq = merged[0].requestSeq
      if (merged.some((candidate) => candidate.requestSeq !== originRequestSeq)) {
        throw new ToolSurfaceError(
          'Activation candidates must share one originating View.',
          'invalid_definition'
        )
      }
      const fingerprint = hashJsonData(merged)
      const consumedFingerprint = consumedReleaseFingerprintByRequestSeq.get(originRequestSeq)
      if (consumedFingerprint !== undefined) {
        if (consumedFingerprint === fingerprint) return
        throw new ToolSurfaceError(
          'Activation candidate batch conflicts with a consumed release.',
          'conflicting_tool'
        )
      }
      if (originRequestSeq !== origin.requestSeq) {
        throw new ToolSurfaceError(
          'Activation candidates must originate from the latest admitted View.',
          'invalid_definition'
        )
      }
      const admittedTargets = new Set(admittedLedger.entries.map((entry) => entry.stableTargetKey))
      for (const candidate of merged) {
        const ceilingEntry = ceilingEntryByTarget.get(candidate.stableTargetKey)
        if (
          !ceilingEntry ||
          ceilingEntry.canonicalToolDefinitionHash !== candidate.canonicalToolDefinitionHash ||
          admittedTargets.has(candidate.stableTargetKey) ||
          isToolSearchCatalogEntry(ceilingEntry)
        ) {
          throw new ToolSurfaceError(
            'Activation candidate is outside the exact Run Tool Ceiling.',
            'conflicting_tool'
          )
        }
      }
      if (pendingCandidates) {
        if (pendingFingerprint === fingerprint) return
        throw new ToolSurfaceError(
          'Activation candidate batch conflicts with an existing release.',
          'conflicting_tool'
        )
      }
      pendingCandidates = merged
      pendingOriginRequest = origin
      pendingFingerprint = fingerprint
    },
    build: ({ request, eligibleDefinitions, toolSearchAvailable }) => {
      if (toolSearchAvailable !== true) {
        throw new ToolSurfaceError(
          'Virtualized Tool Surface requires current ToolSearch authority.',
          'invalid_definition'
        )
      }
      if (
        latestAdmittedRequest &&
        (request.sessionId !== latestAdmittedRequest.sessionId ||
          request.messageId !== latestAdmittedRequest.messageId ||
          request.runId !== latestAdmittedRequest.runId ||
          request.requestSeq <= latestAdmittedRequest.requestSeq)
      ) {
        throw new ToolSurfaceError(
          'Tool Surface proposal must advance the admitted Run View.',
          'invalid_definition'
        )
      }
      if (
        pendingCandidates &&
        (!pendingOriginRequest ||
          request.sessionId !== pendingOriginRequest.sessionId ||
          request.messageId !== pendingOriginRequest.messageId ||
          request.runId !== pendingOriginRequest.runId ||
          request.requestSeq <= pendingOriginRequest.requestSeq)
      ) {
        throw new ToolSurfaceError(
          'An activation proposal must be a later View in the same Run scope.',
          'invalid_definition'
        )
      }
      buildCanonicalToolCatalog([...eligibleDefinitions, runToolSearchDefinition])
      const effectiveEligibleDefinitions: MCPToolDefinition[] = []
      const eligibleIdentities: ToolSurfaceDefinitionIdentity[] = []
      const driftedTargets = new Set<string>()
      for (const definition of [...eligibleDefinitions, runToolSearchDefinition]) {
        const ceilingEntry = ceilingEntryByVisibleName.get(definition.function.name)
        if (!ceilingEntry) {
          throw new ToolSurfaceError(
            'Eligible Tool Surface is outside the Run Tool Ceiling.',
            'conflicting_tool'
          )
        }
        const liveEntry = buildCanonicalToolCatalog([definition]).entries[0]
        if (!catalogEntryMatches(ceilingEntry, liveEntry)) {
          driftedTargets.add(ceilingEntry.stableTargetKey)
          continue
        }
        effectiveEligibleDefinitions.push(definition)
        eligibleIdentities.push(copyDefinitionIdentity(ceilingEntry))
      }
      const pendingTargets = new Set(
        (pendingCandidates ?? []).map((candidate) => candidate.stableTargetKey)
      )
      if ([...driftedTargets].some((target) => !pendingTargets.has(target))) {
        throw new ToolSurfaceError(
          'Eligible Tool Surface is outside the Run Tool Ceiling.',
          'conflicting_tool'
        )
      }
      const eligibleTargets = new Set(eligibleIdentities.map((entry) => entry.stableTargetKey))
      const eligibleByTarget = new Map(
        eligibleIdentities.map((identity) => [identity.stableTargetKey, identity])
      )
      const ledgerTargets = new Set(admittedLedger.entries.map((entry) => entry.stableTargetKey))
      const decisions: ToolSurfaceActivationDecision[] = []
      const additions: ToolSurfaceDefinitionIdentity[] = []
      let batchTokens = 0
      let totalTokens = admittedLedger.entries.reduce(
        (sum, entry) => sum + (ceilingEntryByTarget.get(entry.stableTargetKey)?.definitionTokens ?? 0),
        0
      )
      for (const candidate of pendingCandidates ?? []) {
        let rejectionCode: ToolSurfaceActivationRejectionCode | undefined
        const ceilingEntry = ceilingEntryByTarget.get(candidate.stableTargetKey)!
        const eligibleIdentity = eligibleByTarget.get(candidate.stableTargetKey)
        if (driftedTargets.has(candidate.stableTargetKey)) {
          rejectionCode = 'definition-drift'
        } else if (!eligibleIdentity || ledgerTargets.has(candidate.stableTargetKey)) {
          rejectionCode = 'ineligible'
        } else if (additions.length >= input.policy.maxActivationCandidatesPerBatch) {
          rejectionCode = 'per-batch-count-cap'
        } else if (
          batchTokens + ceilingEntry.definitionTokens >
          input.policy.maxActivationCandidateDefinitionTokensPerBatch
        ) {
          rejectionCode = 'per-batch-token-cap'
        } else if (admittedActivationBatches >= input.policy.maxActivationBatchesPerRun) {
          rejectionCode = 'per-run-batch-cap'
        } else if (
          admittedAppendedTargets + additions.length >= input.policy.maxAppendedTargetsPerRun
        ) {
          rejectionCode = 'per-run-target-cap'
        } else if (admittedLedger.entries.length + additions.length >= input.policy.maxInitialToolCount) {
          rejectionCode = 'total-surface-count-cap'
        } else if (
          totalTokens + ceilingEntry.definitionTokens > input.policy.maxInitialDefinitionTokens
        ) {
          rejectionCode = 'total-surface-token-cap'
        }
        if (!rejectionCode) {
          additions.push(copyDefinitionIdentity(candidate))
          ledgerTargets.add(candidate.stableTargetKey)
          batchTokens += ceilingEntry.definitionTokens
          totalTokens += ceilingEntry.definitionTokens
        }
        decisions.push({
          ...copyActivationCandidate(candidate),
          accepted: !rejectionCode,
          ...(rejectionCode ? { rejectionCode } : {})
        })
      }
      const nextLedger = appendToolSurfaceActivationBatch(admittedLedger, additions)
      const proposedReasonByTarget = new Map(reasonByTarget)
      for (const addition of additions) proposedReasonByTarget.set(addition.stableTargetKey, 'search-result')
      const selectionReasons = [...proposedReasonByTarget.entries()].flatMap(
        ([stableTargetKey, reason]) =>
          eligibleTargets.has(stableTargetKey) ? [{ stableTargetKey, reason }] : []
      )
      const snapshot = createToolSurfaceSnapshot({
        request,
        policyVersion: input.policy.policyVersion,
        virtualizationTriggered: true,
        ceiling,
        eligibleDefinitions: effectiveEligibleDefinitions,
        activationLedger: nextLedger,
        selectionReasons,
        activation: {
          originRequestSeq: pendingOriginRequest?.requestSeq ?? null,
          decisions
        }
      })
      proposals.set(snapshot, {
        baseLedger: admittedLedger,
        nextLedger,
        pendingCandidates,
        pendingFingerprint,
        appendedTargets: additions.length
      })
      return snapshot
    },
    admit: (snapshot) => {
      assertIssuedToolSurfaceSnapshot(snapshot)
      if (admittedSnapshots.has(snapshot)) return
      const proposal = proposals.get(snapshot)
      if (!proposal) {
        throw new ToolSurfaceError(
          'Tool Surface snapshot was not prepared by this Run controller.',
          'invalid_definition'
        )
      }
      if (proposal.baseLedger !== admittedLedger) {
        throw new ToolSurfaceError(
          'Tool Surface snapshot was prepared from a stale activation ledger.',
          'conflicting_tool'
        )
      }
      if (proposal.pendingCandidates !== pendingCandidates) {
        throw new ToolSurfaceError(
          'Tool Surface snapshot was prepared from stale activation candidates.',
          'conflicting_tool'
        )
      }
      let consumedRelease: { readonly requestSeq: number; readonly fingerprint: string } | null =
        null
      if (proposal.pendingCandidates) {
        const consumedRequestSeq = snapshot.activation.originRequestSeq
        if (
          consumedRequestSeq === null ||
          !proposal.pendingFingerprint ||
          consumedReleaseFingerprintByRequestSeq.size >= MAX_TOOL_SURFACE_CANDIDATE_BATCHES
        ) {
          throw new ToolSurfaceError(
            'Tool Surface consumed activation release is invalid or exceeds its limit.',
            consumedReleaseFingerprintByRequestSeq.size >= MAX_TOOL_SURFACE_CANDIDATE_BATCHES
              ? 'limit_exceeded'
              : 'invalid_definition'
          )
        }
        consumedRelease = Object.freeze({
          requestSeq: consumedRequestSeq,
          fingerprint: proposal.pendingFingerprint
        })
      }
      if (latestExecutionEligibleSnapshot) {
        revokeToolSurfaceExecutionEligibility(latestExecutionEligibleSnapshot)
      }
      admittedLedger = proposal.nextLedger
      latestAdmittedRequest = snapshot.request
      if (proposal.pendingCandidates && consumedRelease) {
        consumedReleaseFingerprintByRequestSeq.set(
          consumedRelease.requestSeq,
          consumedRelease.fingerprint
        )
        admittedActivationBatches += 1
        admittedAppendedTargets += proposal.appendedTargets
        pendingCandidates = null
        pendingOriginRequest = null
        pendingFingerprint = null
        for (const decision of snapshot.activation.decisions) {
          if (decision.accepted) reasonByTarget.set(decision.stableTargetKey, 'search-result')
        }
      }
      proposals.delete(snapshot)
      admittedSnapshots.add(snapshot)
      admittedToolSurfaceSnapshots.add(snapshot)
      latestExecutionEligibleSnapshot = snapshot
    }
  }
  return Object.freeze({ decision, controller: Object.freeze(controller) })
}

function labelFor(index: number): string {
  return `tools[${index}]`
}
