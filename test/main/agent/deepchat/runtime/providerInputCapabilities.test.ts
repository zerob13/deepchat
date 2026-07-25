import { describe, expect, it, vi } from 'vitest'
import {
  resolveProviderInputCapabilities,
  supportsProviderAudioInput,
  supportsProviderVision
} from '@/agent/deepchat/runtime/providerInputCapabilities'

describe('provider input capabilities', () => {
  it('resolves vision and audio with their provider-port argument order', () => {
    const providerSettings = {
      getModelConfig: vi.fn().mockReturnValue({ vision: true }),
      supportsAudioInputCapability: vi.fn().mockReturnValue(true)
    }

    expect(resolveProviderInputCapabilities(providerSettings, 'provider', 'model')).toEqual({
      supportsVision: true,
      supportsAudioInput: true
    })
    expect(providerSettings.getModelConfig).toHaveBeenCalledWith('model', 'provider')
    expect(providerSettings.supportsAudioInputCapability).toHaveBeenCalledWith('provider', 'model')
  })

  it('fails vision closed when the model config is unavailable', () => {
    const providerSettings = {
      getModelConfig: vi.fn().mockReturnValue(undefined),
      supportsAudioInputCapability: vi.fn().mockReturnValue(false)
    }

    expect(resolveProviderInputCapabilities(providerSettings, 'provider', 'missing')).toEqual({
      supportsVision: false,
      supportsAudioInput: false
    })
  })

  it('supports isolated capability reads without querying the unrelated capability', () => {
    const providerSettings = {
      getModelConfig: vi.fn().mockReturnValue({ vision: true }),
      supportsAudioInputCapability: vi.fn().mockReturnValue(false)
    }

    expect(supportsProviderVision(providerSettings, 'provider', 'model')).toBe(true)
    expect(providerSettings.supportsAudioInputCapability).not.toHaveBeenCalled()

    providerSettings.getModelConfig.mockClear()
    expect(supportsProviderAudioInput(providerSettings, 'provider', 'model')).toBe(false)
    expect(providerSettings.getModelConfig).not.toHaveBeenCalled()
  })
})
