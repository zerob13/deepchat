import { describe, expect, it } from 'vitest'
import { ToolSurfaceCanaryDiagnosticsRegistry } from '@/agent/deepchat/runtime/toolSurfaceCanaryDiagnostics'

describe('Tool Surface canary diagnostics', () => {
  const scope = {
    sessionId: 'session-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    toolProfile: 'code' as const
  }

  it('aggregates actual adapter cost inputs, rounds, latency, outcomes, and catalog churn', () => {
    const registry = new ToolSurfaceCanaryDiagnosticsRegistry({ sampleCapacity: 4 })
    const record = (catalogHash: string, outcome: 'completed' | 'error') =>
      registry.recordRun({
        scope,
        adapterMode: 'cli-programmatic',
        policyVersion: 'cli-programmatic-v1',
        catalogHash,
        catalogToolCount: 80,
        catalogDefinitionTokens: 12_000,
        outcome,
        durationMs: outcome === 'completed' ? 100 : 200,
        providerRounds: outcome === 'completed' ? 1 : 3,
        providerAttemptsTruncated: outcome === 'error',
        providerAttempts: [
          {
            requestSeq: 1,
            physicalAttempt: 1,
            usage: { inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 5 }
          },
          {
            requestSeq: 2,
            physicalAttempt: 1,
            usage: { inputTokens: 50, cacheReadTokens: 0 }
          }
        ]
      })

    record('catalog-a', 'completed')
    record('catalog-a', 'completed')
    record('catalog-b', 'error')

    expect(registry.snapshot({ providerId: 'provider-1', modelId: 'model-1' })).toEqual({
      schemaVersion: 1,
      cohorts: [
        expect.objectContaining({
          adapterMode: 'cli-programmatic',
          policyVersion: 'cli-programmatic-v1',
          catalogBand: '65-256',
          toolProfile: 'code',
          runs: {
            observed: 3,
            outcomes: { completed: 2, paused: 0, aborted: 0, error: 1, unsettled: 0 },
            catalogComparisons: 2,
            catalogChanges: 1,
            providerAttemptSamplesTruncated: 1
          },
          attempts: {
            observed: 6,
            withUsage: 6,
            withCacheReadMetric: 6,
            withCacheWriteMetric: 3
          },
          metrics: expect.objectContaining({
            durationMs: { samples: 3, p50: 100, p95: 200, max: 200 },
            providerRounds: { samples: 3, p50: 1, p95: 3, max: 3 },
            extraProviderRounds: { samples: 3, p50: 0, p95: 2, max: 2 },
            requestSequences: { samples: 3, p50: 2, p95: 2, max: 2 },
            physicalAttempts: { samples: 3, p50: 2, p95: 2, max: 2 },
            inputTokens: { samples: 3, p50: 150, p95: 150, max: 150 },
            cacheReadTokens: { samples: 3, p50: 80, p95: 80, max: 80 },
            cacheWriteTokens: { samples: 3, p50: 5, p95: 5, max: 5 },
            catalogDefinitionTokens: {
              samples: 3,
              p50: 12_000,
              p95: 12_000,
              max: 12_000
            }
          })
        })
      ]
    })
    expect(registry.snapshot({ providerId: 'provider-2', modelId: 'model-1' })).toBeNull()
  })

  it('distinguishes unavailable cache metrics from reported zero and bounds cohorts', () => {
    const registry = new ToolSurfaceCanaryDiagnosticsRegistry({
      sampleCapacity: 1,
      cohortCapacity: 1,
      lineageCapacity: 1
    })
    registry.recordRun({
      scope,
      adapterMode: 'full',
      policyVersion: 'full-v1',
      catalogHash: 'catalog-a',
      catalogToolCount: 20,
      catalogDefinitionTokens: 2_000,
      outcome: 'completed',
      durationMs: 10,
      providerRounds: 1,
      providerAttemptsTruncated: false,
      providerAttempts: [
        { requestSeq: 1, physicalAttempt: 1, usage: { inputTokens: 10 } }
      ]
    })
    registry.recordRun({
      scope,
      adapterMode: 'native-activation',
      policyVersion: 'automatic-adapter-v1',
      catalogHash: 'catalog-b',
      catalogToolCount: 40,
      catalogDefinitionTokens: 5_000,
      outcome: 'completed',
      durationMs: 20,
      providerRounds: 1,
      providerAttemptsTruncated: false,
      providerAttempts: [
        {
          requestSeq: 2,
          physicalAttempt: 1,
          usage: { inputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      ]
    })

    const snapshot = registry.snapshot({ providerId: 'provider-1', modelId: 'model-1' })
    expect(snapshot?.cohorts).toHaveLength(1)
    expect(snapshot?.cohorts[0]).toMatchObject({
      adapterMode: 'native-activation',
      attempts: { withCacheReadMetric: 1, withCacheWriteMetric: 1 },
      metrics: {
        cacheReadTokens: { samples: 1, p50: 0 },
        cacheWriteTokens: { samples: 1, p50: 0 }
      }
    })
  })

  it('drops malformed or oversized diagnostic input without affecting routing state', () => {
    const registry = new ToolSurfaceCanaryDiagnosticsRegistry()
    registry.recordRun({
      scope: { ...scope, sessionId: ' session-1 ' },
      adapterMode: 'full',
      policyVersion: 'full-v1',
      catalogHash: 'catalog-a',
      catalogToolCount: 1,
      catalogDefinitionTokens: 1,
      outcome: 'completed',
      durationMs: 1,
      providerRounds: 1,
      providerAttemptsTruncated: false,
      providerAttempts: []
    })

    expect(registry.snapshot({ providerId: 'provider-1', modelId: 'model-1' })).toBeNull()
  })

  it('rejects legacy adapters and attempt arrays beyond the bounded Run sample', () => {
    const registry = new ToolSurfaceCanaryDiagnosticsRegistry()
    const baseRecord = {
      scope,
      policyVersion: 'full-v1',
      catalogHash: 'catalog-a',
      catalogToolCount: 1,
      catalogDefinitionTokens: 1,
      outcome: 'completed' as const,
      durationMs: 1,
      providerRounds: 1,
      providerAttemptsTruncated: true
    }

    registry.recordRun({
      ...baseRecord,
      adapterMode: 'legacy' as 'full',
      providerAttempts: []
    })
    registry.recordRun({
      ...baseRecord,
      adapterMode: 'full',
      providerAttempts: Array.from({ length: 65 }, (_, index) => ({
        requestSeq: index + 1,
        physicalAttempt: 1,
        usage: null
      }))
    })

    expect(registry.snapshot({ providerId: 'provider-1', modelId: 'model-1' })).toBeNull()
  })
})
