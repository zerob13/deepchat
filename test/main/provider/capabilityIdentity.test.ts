import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  mockDb: {
    providers: {
      moonshot: {
        id: 'moonshot',
        models: [
          {
            id: 'kimi-k3',
            temperature: false,
            reasoning: {
              supported: true,
              default: true
            },
            extra_capabilities: {
              reasoning: {
                supported: true,
                interleaved: true,
                summaries: true,
                visibility: 'summary',
                continuation: ['thinking_blocks']
              }
            }
          }
        ]
      },
      aihubmix: {
        id: 'aihubmix',
        models: [
          {
            id: 'kimi-k3',
            reasoning: {
              supported: true,
              default: true
            },
            extra_capabilities: {
              reasoning: {
                supported: true
              }
            }
          },
          { id: 'ambiguous-model', temperature: true }
        ]
      },
      llmgateway: {
        id: 'llmgateway',
        models: [
          { id: 'kimi-k3', temperature: false },
          { id: 'ambiguous-model', temperature: false }
        ]
      },
      anthropic: {
        id: 'anthropic',
        models: [
          {
            id: 'claude-opus-4-7',
            temperature: false,
            reasoning: {
              supported: true,
              default: true
            }
          },
          {
            id: 'minimax-m3',
            temperature: false,
            reasoning: {
              supported: true,
              default: true
            }
          }
        ]
      },
      openrouter: {
        id: 'openrouter',
        models: [
          {
            id: 'anthropic/claude-opus-4-7',
            temperature: true,
            reasoning: {
              supported: true,
              default: true
            }
          }
        ]
      },
      google: {
        id: 'google',
        models: [{ id: 'gemini-3.5-pro', temperature: true }]
      },
      'sole-provider': {
        id: 'sole-provider',
        models: [{ id: 'only-once', temperature: false }]
      }
    }
  }
}))

vi.mock('../../../src/main/provider/providerDbLoader', () => ({
  providerDbLoader: {
    getDb: () => state.mockDb,
    subscribeCatalogChanges: vi.fn()
  }
}))

import {
  buildResolvedCapabilitySnapshot,
  resolveCapabilityFamilyHint,
  resolveCapabilityIdentity
} from '../../../src/main/provider/capabilityIdentity'

describe('capability identity resolution', () => {
  it('resolves New API K3 to the Moonshot catalog record before transport', () => {
    const identity = resolveCapabilityIdentity({
      providerId: 'new-api',
      modelId: 'kimi-k3',
      endpointType: 'openai'
    })
    const snapshot = buildResolvedCapabilitySnapshot(identity)

    expect(identity).toEqual({
      providerId: 'moonshot',
      modelId: 'kimi-k3',
      catalogMatched: true
    })
    expect(snapshot.temperatureCapability).toBe(false)
    expect(snapshot.requestPolicy).toEqual({
      temperature: { mode: 'omit' },
      topP: { mode: 'omit' },
      reasoning: { mode: 'fixed', value: true },
      legacyThinking: { mode: 'omit' }
    })
    expect(snapshot.supportsReasoningEffort).toBe(true)
    expect(snapshot.reasoningEffortDefault).toBe('max')
    expect(snapshot.reasoningPortrait).toMatchObject({
      supported: true,
      mode: 'effort',
      effort: 'max',
      effortOptions: ['low', 'high', 'max'],
      interleaved: true,
      summaries: true,
      visibility: 'summary',
      continuation: ['thinking_blocks']
    })
  })

  it('keeps provider-local carrier records ahead of namespace and family matches', () => {
    expect(
      resolveCapabilityIdentity({
        providerId: 'openrouter',
        modelId: 'anthropic/claude-opus-4-7'
      })
    ).toMatchObject({
      providerId: 'openrouter',
      catalogMatched: true
    })
  })

  it('applies ZenMux and OpenCode Go route overrides in the main-process resolver', () => {
    expect(
      resolveCapabilityIdentity({
        providerId: 'zenmux',
        modelId: 'anthropic/claude-opus-4-7'
      })
    ).toMatchObject({
      providerId: 'anthropic'
    })
    expect(
      resolveCapabilityIdentity({
        providerId: 'opencode-go',
        modelId: 'minimax-m3'
      })
    ).toMatchObject({
      providerId: 'anthropic'
    })
  })

  it('does not choose an ambiguous global model by provider iteration order', () => {
    expect(
      resolveCapabilityIdentity({
        providerId: 'custom-relay',
        modelId: 'ambiguous-model'
      })
    ).toEqual({
      providerId: 'custom-relay',
      modelId: 'ambiguous-model',
      catalogMatched: false
    })

    expect(
      resolveCapabilityIdentity({
        providerId: 'custom-relay',
        modelId: 'only-once'
      })
    ).toEqual({
      providerId: 'sole-provider',
      modelId: 'only-once',
      catalogMatched: true
    })
  })

  it('keeps explicit provider overrides authoritative even without a catalog model', () => {
    expect(
      resolveCapabilityIdentity({
        providerId: 'custom-relay',
        modelId: 'unknown-model',
        explicitProviderId: 'capability-team'
      })
    ).toEqual({
      providerId: 'capability-team',
      modelId: 'unknown-model',
      catalogMatched: false
    })
  })

  it('keeps Phase 1 narrow and transport fallback internal to identity resolution', () => {
    expect(resolveCapabilityFamilyHint('claude-opus-4-7')).toBe('anthropic')
    expect(resolveCapabilityFamilyHint('proxy-model', 'Google Gemini')).toBe('gemini')
    expect(resolveCapabilityFamilyHint('kimi-k3', 'Moonshot')).toBeUndefined()
    expect(
      resolveCapabilityIdentity({
        providerId: 'new-api',
        modelId: 'unknown-gemini-model',
        endpointType: 'gemini'
      })
    ).toMatchObject({
      providerId: 'google',
      catalogMatched: false
    })
    expect(
      resolveCapabilityIdentity({
        providerId: 'custom-relay',
        modelId: 'unknown-model'
      })
    ).toMatchObject({
      providerId: 'custom-relay',
      catalogMatched: false
    })
  })
})
