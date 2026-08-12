import type { DeepChatToolProfileKind } from '@/agent/deepchat/instance/deepChatAgentInstance'
import type { LoopRunToolSurfaceMode } from '@/agent/deepchat/loop/loopRun'
import { hashJsonData } from '@/tape/domain/canonicalJson'
import type { ToolSurfaceProviderAttemptDiagnostic } from './toolSurfaceDiagnostics'

export const TOOL_SURFACE_CANARY_DIAGNOSTICS_SCHEMA_VERSION = 1
export const MAX_TOOL_SURFACE_PROVIDER_ATTEMPTS_PER_RUN = 64

const DEFAULT_SAMPLE_CAPACITY = 256
const MAX_SAMPLE_CAPACITY = 4_096
const DEFAULT_COHORT_CAPACITY = 64
const MAX_COHORT_CAPACITY = 256
const DEFAULT_LINEAGE_CAPACITY = 512
const MAX_LINEAGE_CAPACITY = 2_048
const MAX_SCOPE_FIELD_CODE_UNITS = 1_024
const MAX_SCOPE_FIELD_BYTES = 4_096
const ACTUAL_ADAPTER_MODES = Object.freeze([
  'full',
  'native-activation',
  'cli-programmatic'
] as const)

export type ToolSurfaceCatalogBand = '0-32' | '33-64' | '65-256' | '257+'
export type ToolSurfaceCanaryRunOutcome =
  | 'completed'
  | 'paused'
  | 'aborted'
  | 'error'
  | 'unsettled'

export interface ToolSurfaceCanaryDiagnosticsScope {
  readonly sessionId: string
  readonly providerId: string
  readonly modelId: string
  readonly toolProfile: DeepChatToolProfileKind
}

export interface ToolSurfaceCanaryDistribution {
  readonly samples: number
  readonly p50: number | null
  readonly p95: number | null
  readonly max: number | null
}

export interface ToolSurfaceCanaryCohortSnapshot {
  readonly adapterMode: Exclude<LoopRunToolSurfaceMode, 'legacy'>
  readonly policyVersion: string
  readonly catalogBand: ToolSurfaceCatalogBand
  readonly toolProfile: DeepChatToolProfileKind
  readonly runs: {
    readonly observed: number
    readonly outcomes: Readonly<Record<ToolSurfaceCanaryRunOutcome, number>>
    readonly catalogComparisons: number
    readonly catalogChanges: number
    readonly providerAttemptSamplesTruncated: number
  }
  readonly attempts: {
    readonly observed: number
    readonly withUsage: number
    readonly withCacheReadMetric: number
    readonly withCacheWriteMetric: number
  }
  readonly metrics: {
    readonly durationMs: ToolSurfaceCanaryDistribution
    readonly providerRounds: ToolSurfaceCanaryDistribution
    readonly extraProviderRounds: ToolSurfaceCanaryDistribution
    readonly requestSequences: ToolSurfaceCanaryDistribution
    readonly physicalAttempts: ToolSurfaceCanaryDistribution
    readonly inputTokens: ToolSurfaceCanaryDistribution
    readonly cacheReadTokens: ToolSurfaceCanaryDistribution
    readonly cacheWriteTokens: ToolSurfaceCanaryDistribution
    readonly catalogDefinitionTokens: ToolSurfaceCanaryDistribution
  }
}

export interface ToolSurfaceCanaryDiagnosticsSnapshot {
  readonly schemaVersion: typeof TOOL_SURFACE_CANARY_DIAGNOSTICS_SCHEMA_VERSION
  readonly cohorts: readonly ToolSurfaceCanaryCohortSnapshot[]
}

class BoundedNumberRing {
  private readonly values: number[]
  private nextIndex = 0
  private size = 0

  constructor(private readonly capacity: number) {
    this.values = Array<number>(capacity)
  }

  push(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) return
    this.values[this.nextIndex] = value
    this.nextIndex = (this.nextIndex + 1) % this.capacity
    this.size = Math.min(this.size + 1, this.capacity)
  }

  snapshot(): number[] {
    if (this.size < this.capacity) return this.values.slice(0, this.size)
    return [...this.values.slice(this.nextIndex), ...this.values.slice(0, this.nextIndex)]
  }
}

function distribution(values: readonly number[]): ToolSurfaceCanaryDistribution {
  if (values.length === 0) return { samples: 0, p50: null, p95: null, max: null }
  const sorted = [...values].sort((left, right) => left - right)
  const nearestRank = (percentile: number): number =>
    sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]
  return {
    samples: sorted.length,
    p50: nearestRank(0.5),
    p95: nearestRank(0.95),
    max: sorted.at(-1) ?? null
  }
}

function increment(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1)
}

function addSafe(left: number, right: number): number {
  if (!Number.isSafeInteger(right) || right < 0) return left
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function isBoundedField(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SCOPE_FIELD_CODE_UNITS &&
    value === value.trim() &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_SCOPE_FIELD_BYTES
  )
}

function isToolProfile(value: string): value is DeepChatToolProfileKind {
  return value === 'code' || value === 'research' || value === 'analysis' || value === 'general'
}

function catalogBand(toolCount: number): ToolSurfaceCatalogBand {
  if (toolCount <= 32) return '0-32'
  if (toolCount <= 64) return '33-64'
  if (toolCount <= 256) return '65-256'
  return '257+'
}

function emptyOutcomes(): Record<ToolSurfaceCanaryRunOutcome, number> {
  return { completed: 0, paused: 0, aborted: 0, error: 0, unsettled: 0 }
}

class ToolSurfaceCanaryCohort {
  private observedRuns = 0
  private readonly outcomes = emptyOutcomes()
  private catalogComparisons = 0
  private catalogChanges = 0
  private providerAttemptSamplesTruncated = 0
  private observedAttempts = 0
  private attemptsWithUsage = 0
  private attemptsWithCacheReadMetric = 0
  private attemptsWithCacheWriteMetric = 0
  private readonly durationMs: BoundedNumberRing
  private readonly providerRounds: BoundedNumberRing
  private readonly extraProviderRounds: BoundedNumberRing
  private readonly requestSequences: BoundedNumberRing
  private readonly physicalAttempts: BoundedNumberRing
  private readonly inputTokens: BoundedNumberRing
  private readonly cacheReadTokens: BoundedNumberRing
  private readonly cacheWriteTokens: BoundedNumberRing
  private readonly catalogDefinitionTokens: BoundedNumberRing

  constructor(
    private readonly identity: Omit<ToolSurfaceCanaryCohortSnapshot, 'runs' | 'attempts' | 'metrics'>,
    sampleCapacity: number
  ) {
    this.durationMs = new BoundedNumberRing(sampleCapacity)
    this.providerRounds = new BoundedNumberRing(sampleCapacity)
    this.extraProviderRounds = new BoundedNumberRing(sampleCapacity)
    this.requestSequences = new BoundedNumberRing(sampleCapacity)
    this.physicalAttempts = new BoundedNumberRing(sampleCapacity)
    this.inputTokens = new BoundedNumberRing(sampleCapacity)
    this.cacheReadTokens = new BoundedNumberRing(sampleCapacity)
    this.cacheWriteTokens = new BoundedNumberRing(sampleCapacity)
    this.catalogDefinitionTokens = new BoundedNumberRing(sampleCapacity)
  }

  record(input: {
    readonly outcome: ToolSurfaceCanaryRunOutcome
    readonly durationMs: number
    readonly providerRounds: number
    readonly catalogDefinitionTokens: number
    readonly catalogRelation: 'first' | 'unchanged' | 'changed'
    readonly providerAttempts: readonly ToolSurfaceProviderAttemptDiagnostic[]
    readonly providerAttemptsTruncated: boolean
  }): void {
    this.observedRuns = increment(this.observedRuns)
    this.outcomes[input.outcome] = increment(this.outcomes[input.outcome])
    this.durationMs.push(input.durationMs)
    this.providerRounds.push(input.providerRounds)
    this.extraProviderRounds.push(Math.max(0, input.providerRounds - 1))
    this.catalogDefinitionTokens.push(input.catalogDefinitionTokens)
    if (input.catalogRelation !== 'first') {
      this.catalogComparisons = increment(this.catalogComparisons)
      if (input.catalogRelation === 'changed') {
        this.catalogChanges = increment(this.catalogChanges)
      }
    }
    if (input.providerAttemptsTruncated) {
      this.providerAttemptSamplesTruncated = increment(this.providerAttemptSamplesTruncated)
    }

    let runInputTokens = 0
    let runCacheReadTokens = 0
    let runCacheWriteTokens = 0
    let hasInputUsage = false
    let hasCacheReadUsage = false
    let hasCacheWriteUsage = false
    const requestSequences = new Set<number>()
    for (const attempt of input.providerAttempts) {
      this.observedAttempts = increment(this.observedAttempts)
      if (Number.isSafeInteger(attempt.requestSeq) && attempt.requestSeq > 0) {
        requestSequences.add(attempt.requestSeq)
      }
      if (!attempt.usage) continue
      this.attemptsWithUsage = increment(this.attemptsWithUsage)
      hasInputUsage = true
      runInputTokens = addSafe(runInputTokens, attempt.usage.inputTokens)
      if (attempt.usage.cacheReadTokens !== undefined) {
        this.attemptsWithCacheReadMetric = increment(this.attemptsWithCacheReadMetric)
        hasCacheReadUsage = true
        runCacheReadTokens = addSafe(runCacheReadTokens, attempt.usage.cacheReadTokens)
      }
      if (attempt.usage.cacheWriteTokens !== undefined) {
        this.attemptsWithCacheWriteMetric = increment(this.attemptsWithCacheWriteMetric)
        hasCacheWriteUsage = true
        runCacheWriteTokens = addSafe(runCacheWriteTokens, attempt.usage.cacheWriteTokens)
      }
    }
    this.requestSequences.push(requestSequences.size)
    this.physicalAttempts.push(input.providerAttempts.length)
    if (hasInputUsage) this.inputTokens.push(runInputTokens)
    if (hasCacheReadUsage) this.cacheReadTokens.push(runCacheReadTokens)
    if (hasCacheWriteUsage) this.cacheWriteTokens.push(runCacheWriteTokens)
  }

  snapshot(): ToolSurfaceCanaryCohortSnapshot {
    return {
      ...this.identity,
      runs: {
        observed: this.observedRuns,
        outcomes: { ...this.outcomes },
        catalogComparisons: this.catalogComparisons,
        catalogChanges: this.catalogChanges,
        providerAttemptSamplesTruncated: this.providerAttemptSamplesTruncated
      },
      attempts: {
        observed: this.observedAttempts,
        withUsage: this.attemptsWithUsage,
        withCacheReadMetric: this.attemptsWithCacheReadMetric,
        withCacheWriteMetric: this.attemptsWithCacheWriteMetric
      },
      metrics: {
        durationMs: distribution(this.durationMs.snapshot()),
        providerRounds: distribution(this.providerRounds.snapshot()),
        extraProviderRounds: distribution(this.extraProviderRounds.snapshot()),
        requestSequences: distribution(this.requestSequences.snapshot()),
        physicalAttempts: distribution(this.physicalAttempts.snapshot()),
        inputTokens: distribution(this.inputTokens.snapshot()),
        cacheReadTokens: distribution(this.cacheReadTokens.snapshot()),
        cacheWriteTokens: distribution(this.cacheWriteTokens.snapshot()),
        catalogDefinitionTokens: distribution(this.catalogDefinitionTokens.snapshot())
      }
    }
  }
}

type CohortEntry = {
  readonly providerModelKey: string
  readonly cohort: ToolSurfaceCanaryCohort
}

/** Bounded process-live canary metrics. This registry never reads Tape or participates in routing. */
export class ToolSurfaceCanaryDiagnosticsRegistry {
  private readonly cohorts = new Map<string, CohortEntry>()
  private readonly priorCatalogs = new Map<string, string>()
  private readonly sampleCapacity: number
  private readonly cohortCapacity: number
  private readonly lineageCapacity: number

  constructor(options: {
    readonly sampleCapacity?: number
    readonly cohortCapacity?: number
    readonly lineageCapacity?: number
  } = {}) {
    this.sampleCapacity = this.boundCapacity(
      options.sampleCapacity,
      DEFAULT_SAMPLE_CAPACITY,
      MAX_SAMPLE_CAPACITY
    )
    this.cohortCapacity = this.boundCapacity(
      options.cohortCapacity,
      DEFAULT_COHORT_CAPACITY,
      MAX_COHORT_CAPACITY
    )
    this.lineageCapacity = this.boundCapacity(
      options.lineageCapacity,
      DEFAULT_LINEAGE_CAPACITY,
      MAX_LINEAGE_CAPACITY
    )
  }

  recordRun(input: {
    readonly scope: ToolSurfaceCanaryDiagnosticsScope
    readonly adapterMode: Exclude<LoopRunToolSurfaceMode, 'legacy'>
    readonly policyVersion: string
    readonly catalogHash: string
    readonly catalogToolCount: number
    readonly catalogDefinitionTokens: number
    readonly outcome: ToolSurfaceCanaryRunOutcome
    readonly durationMs: number
    readonly providerRounds: number
    readonly providerAttempts: readonly ToolSurfaceProviderAttemptDiagnostic[]
    readonly providerAttemptsTruncated: boolean
  }): void {
    try {
      if (
        !this.validScope(input.scope) ||
        !isBoundedField(input.policyVersion) ||
        !isBoundedField(input.catalogHash) ||
        !Number.isSafeInteger(input.catalogToolCount) ||
        input.catalogToolCount < 0 ||
        !Number.isSafeInteger(input.catalogDefinitionTokens) ||
        input.catalogDefinitionTokens < 0 ||
        !Number.isSafeInteger(input.durationMs) ||
        input.durationMs < 0 ||
        !Number.isSafeInteger(input.providerRounds) ||
        input.providerRounds < 0 ||
        !(ACTUAL_ADAPTER_MODES as readonly string[]).includes(input.adapterMode) ||
        !['completed', 'paused', 'aborted', 'error', 'unsettled'].includes(input.outcome) ||
        !Array.isArray(input.providerAttempts) ||
        input.providerAttempts.length > MAX_TOOL_SURFACE_PROVIDER_ATTEMPTS_PER_RUN ||
        typeof input.providerAttemptsTruncated !== 'boolean'
      ) {
        return
      }
      const providerModelKey = hashJsonData({
        domain: 'tool-surface-canary-provider-model-v1',
        providerId: input.scope.providerId,
        modelId: input.scope.modelId
      })
      const band = catalogBand(input.catalogToolCount)
      const cohortKey = hashJsonData({
        domain: 'tool-surface-canary-cohort-v1',
        providerModelKey,
        adapterMode: input.adapterMode,
        policyVersion: input.policyVersion,
        catalogBand: band,
        toolProfile: input.scope.toolProfile
      })
      const lineageKey = hashJsonData({
        domain: 'tool-surface-canary-lineage-v1',
        sessionId: input.scope.sessionId,
        providerModelKey,
        adapterMode: input.adapterMode,
        policyVersion: input.policyVersion,
        toolProfile: input.scope.toolProfile
      })
      const previousCatalogHash = this.priorCatalogs.get(lineageKey)
      const catalogRelation =
        previousCatalogHash === undefined
          ? 'first'
          : previousCatalogHash === input.catalogHash
            ? 'unchanged'
            : 'changed'
      this.priorCatalogs.delete(lineageKey)
      this.priorCatalogs.set(lineageKey, input.catalogHash)
      this.trimMap(this.priorCatalogs, this.lineageCapacity)

      let entry = this.cohorts.get(cohortKey)
      if (!entry) {
        entry = {
          providerModelKey,
          cohort: new ToolSurfaceCanaryCohort(
            {
              adapterMode: input.adapterMode,
              policyVersion: input.policyVersion,
              catalogBand: band,
              toolProfile: input.scope.toolProfile
            },
            this.sampleCapacity
          )
        }
      }
      this.cohorts.delete(cohortKey)
      this.cohorts.set(cohortKey, entry)
      this.trimMap(this.cohorts, this.cohortCapacity)
      entry.cohort.record({
        outcome: input.outcome,
        durationMs: input.durationMs,
        providerRounds: input.providerRounds,
        catalogDefinitionTokens: input.catalogDefinitionTokens,
        catalogRelation,
        providerAttempts: input.providerAttempts,
        providerAttemptsTruncated: input.providerAttemptsTruncated
      })
    } catch {}
  }

  snapshot(input: {
    readonly providerId: string
    readonly modelId: string
  }): ToolSurfaceCanaryDiagnosticsSnapshot | null {
    if (!isBoundedField(input.providerId) || !isBoundedField(input.modelId)) return null
    const providerModelKey = hashJsonData({
      domain: 'tool-surface-canary-provider-model-v1',
      providerId: input.providerId,
      modelId: input.modelId
    })
    const cohorts = [...this.cohorts.values()]
      .filter((entry) => entry.providerModelKey === providerModelKey)
      .map((entry) => entry.cohort.snapshot())
      .sort((left, right) =>
        `${left.adapterMode}\0${left.policyVersion}\0${left.catalogBand}\0${left.toolProfile}`.localeCompare(
          `${right.adapterMode}\0${right.policyVersion}\0${right.catalogBand}\0${right.toolProfile}`
        )
      )
    return cohorts.length === 0
      ? null
      : { schemaVersion: TOOL_SURFACE_CANARY_DIAGNOSTICS_SCHEMA_VERSION, cohorts }
  }

  private validScope(scope: ToolSurfaceCanaryDiagnosticsScope): boolean {
    return (
      isBoundedField(scope.sessionId) &&
      isBoundedField(scope.providerId) &&
      isBoundedField(scope.modelId) &&
      isToolProfile(scope.toolProfile)
    )
  }

  private boundCapacity(value: number | undefined, fallback: number, maximum: number): number {
    return value !== undefined && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, maximum)
      : fallback
  }

  private trimMap<K, V>(map: Map<K, V>, capacity: number): void {
    while (map.size > capacity) {
      const oldestKey = map.keys().next().value
      if (oldestKey === undefined) return
      map.delete(oldestKey)
    }
  }
}
