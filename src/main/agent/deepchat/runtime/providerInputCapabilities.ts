import type { ProviderModelResolutionPort } from '@/provider/settings'

export interface ProviderInputCapabilities {
  supportsVision: boolean
  supportsAudioInput: boolean
}

type VisionCapabilityPort = Pick<ProviderModelResolutionPort, 'getModelConfig'>
type AudioInputCapabilityPort = Pick<
  ProviderModelResolutionPort,
  'supportsAudioInputCapability'
>

export function supportsProviderVision(
  providerSettings: VisionCapabilityPort,
  providerId: string,
  modelId: string
): boolean {
  return Boolean(providerSettings.getModelConfig(modelId, providerId)?.vision)
}

export function supportsProviderAudioInput(
  providerSettings: AudioInputCapabilityPort,
  providerId: string,
  modelId: string
): boolean {
  return providerSettings.supportsAudioInputCapability(providerId, modelId)
}

export function resolveProviderInputCapabilities(
  providerSettings: VisionCapabilityPort & AudioInputCapabilityPort,
  providerId: string,
  modelId: string
): ProviderInputCapabilities {
  return {
    supportsVision: supportsProviderVision(providerSettings, providerId, modelId),
    supportsAudioInput: supportsProviderAudioInput(providerSettings, providerId, modelId)
  }
}
