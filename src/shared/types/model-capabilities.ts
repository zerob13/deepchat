import type { ReasoningEffort, ReasoningPortrait, Verbosity } from './model-db'
import type { ModelType, NewApiEndpointType } from '../model'
import type { ModelRequestPolicy } from '../modelRequestPolicy'

export const CAPABILITY_IDENTITY_SOURCES = [
  'provider-override',
  'route-override',
  'provider-model',
  'model-namespace',
  'model-owner',
  'model-family',
  'transport-model',
  'unique-model',
  'transport-fallback'
] as const

export type CapabilityIdentitySource = (typeof CAPABILITY_IDENTITY_SOURCES)[number]

export type ResolvedCapabilityIdentity = {
  providerId: string
  modelId: string
  source: CapabilityIdentitySource
  catalogMatched: boolean
}

export type CapabilityRouteOverride = {
  endpointType?: NewApiEndpointType
  supportedEndpointTypes?: NewApiEndpointType[]
  type?: ModelType
  ownedBy?: string
}

export type CapabilitySnapshotOptions = {
  routeOverride?: CapabilityRouteOverride
  reasoning?: boolean
}

export type ResolvedModelCapabilitySnapshot = {
  identity: ResolvedCapabilityIdentity
  requestPolicy: ModelRequestPolicy
  supportsAudioInput: boolean
  supportsReasoning: boolean
  reasoningPortrait: ReasoningPortrait | null
  thinkingBudgetRange: {
    min?: number
    max?: number
    default?: number
  }
  supportsSearch: boolean
  searchDefaults: {
    default?: boolean
    forced?: boolean
    strategy?: 'turbo' | 'max'
  }
  temperatureCapability: boolean | undefined
  supportsTemperatureControl: boolean
  supportsReasoningEffort: boolean
  reasoningEffortDefault: ReasoningEffort | undefined
  supportsVerbosity: boolean
  verbosityDefault: Verbosity | undefined
}
