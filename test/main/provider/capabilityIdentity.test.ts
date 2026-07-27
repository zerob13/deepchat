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
          {
            id: 'coding-kimi-k3',
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
          { id: 'ambiguous-model', temperature: false },
          { id: 'hunyuan-ambiguous', reasoning: { supported: true } }
        ]
      },
      mirror: {
        id: 'mirror',
        models: [{ id: 'hunyuan-ambiguous', reasoning: { supported: false }, temperature: false }]
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
      zhipuai: {
        id: 'zhipuai',
        models: [
          {
            id: 'glm-4.7',
            temperature: true,
            reasoning: { supported: true, default: true },
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
      minimax: {
        id: 'minimax',
        models: [
          {
            id: 'MiniMax-M2',
            temperature: true,
            reasoning: { supported: true, default: true }
          }
        ]
      },
      stepfun: {
        id: 'stepfun',
        models: [
          {
            id: 'step-3.5-flash',
            temperature: true,
            reasoning: { supported: true, default: true }
          }
        ]
      },
      mistral: {
        id: 'mistral',
        models: [{ id: 'mistral-large-latest', temperature: true }]
      },
      cohere: {
        id: 'cohere',
        models: [{ id: 'command-r-plus-08-2024', temperature: true }]
      },
      openai: {
        id: 'openai',
        models: []
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
      requestModelId: 'kimi-k3',
      catalogMatched: true,
      catalogModelId: 'kimi-k3'
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
    const zenmuxIdentity = resolveCapabilityIdentity({
      providerId: 'zenmux',
      modelId: 'anthropic/claude-opus-4-7'
    })
    expect(zenmuxIdentity).toMatchObject({
      providerId: 'anthropic'
    })
    expect(buildResolvedCapabilitySnapshot(zenmuxIdentity).requestPolicy.topP).toEqual({
      mode: 'omit'
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
      requestModelId: 'ambiguous-model',
      catalogMatched: false,
      catalogModelId: null
    })

    expect(
      resolveCapabilityIdentity({
        providerId: 'custom-relay',
        modelId: 'only-once'
      })
    ).toEqual({
      providerId: 'sole-provider',
      requestModelId: 'only-once',
      catalogMatched: true,
      catalogModelId: 'only-once'
    })

    expect(
      resolveCapabilityIdentity({
        providerId: 'new-api',
        modelId: 'hunyuan-ambiguous',
        endpointType: 'openai'
      })
    ).toEqual({
      providerId: 'openai',
      requestModelId: 'hunyuan-ambiguous',
      catalogMatched: false,
      catalogModelId: null
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
      requestModelId: 'unknown-model',
      catalogMatched: false,
      catalogModelId: null
    })
  })

  it('resolves authoritative model origins without selecting an arbitrary mirror', () => {
    expect(
      resolveCapabilityIdentity({
        providerId: 'new-api',
        modelId: 'z-ai/glm_4.7',
        endpointType: 'openai'
      })
    ).toEqual({
      providerId: 'zhipuai',
      requestModelId: 'z-ai/glm_4.7',
      catalogMatched: true,
      catalogModelId: 'glm-4.7'
    })

    expect(
      resolveCapabilityIdentity({
        providerId: 'new-api',
        modelId: 'minimax-m2',
        endpointType: 'openai'
      })
    ).toEqual({
      providerId: 'minimax',
      requestModelId: 'minimax-m2',
      catalogMatched: true,
      catalogModelId: 'minimax-m2'
    })

    const gptOssIdentity = resolveCapabilityIdentity({
      providerId: 'new-api',
      modelId: 'gpt-oss-120b',
      endpointType: 'openai'
    })
    expect(gptOssIdentity).toEqual({
      providerId: 'openai',
      requestModelId: 'gpt-oss-120b',
      catalogMatched: false,
      catalogModelId: null
    })
    expect(buildResolvedCapabilitySnapshot(gptOssIdentity)).toMatchObject({
      supportsReasoning: true,
      reasoningPortrait: {
        supported: true,
        defaultEnabled: true
      },
      temperatureCapability: undefined
    })

    for (const [modelId, providerId, catalogModelId] of [
      ['step-3.5-flash', 'stepfun', 'step-3.5-flash'],
      ['mistralai/mistral-large-latest', 'mistral', 'mistral-large-latest'],
      ['cohere/command-r-plus-08-2024', 'cohere', 'command-r-plus-08-2024']
    ] as const) {
      expect(
        resolveCapabilityIdentity({
          providerId: 'new-api',
          modelId,
          endpointType: 'openai'
        })
      ).toMatchObject({
        providerId,
        catalogMatched: true,
        catalogModelId
      })
    }
  })

  it('uses the same K3 alias identity for request policy and catalog capabilities', () => {
    const identity = resolveCapabilityIdentity({
      providerId: 'new-api',
      modelId: 'coding-kimi-k3-free',
      endpointType: 'openai'
    })

    expect(identity).toEqual({
      providerId: 'moonshot',
      requestModelId: 'coding-kimi-k3-free',
      catalogMatched: true,
      catalogModelId: 'kimi-k3'
    })
    expect(buildResolvedCapabilitySnapshot(identity)).toMatchObject({
      requestPolicy: {
        temperature: { mode: 'omit' },
        topP: { mode: 'omit' }
      },
      reasoningPortrait: {
        interleaved: true,
        visibility: 'summary'
      }
    })

    expect(
      resolveCapabilityIdentity({
        providerId: 'aihubmix',
        modelId: 'kimi_k3'
      })
    ).toMatchObject({
      providerId: 'aihubmix',
      catalogMatched: true,
      catalogModelId: 'kimi-k3'
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
