import type { ReasoningEffort, ReasoningPortrait, Verbosity } from './model-db'
import type { ModelType, NewApiEndpointType } from '../model'
import type { ModelRequestPolicy } from '../modelRequestPolicy'

export type ResolvedCapabilityIdentity =
  | {
      providerId: string
      requestModelId: string
      catalogMatched: true
      catalogModelId: string
    }
  | {
      providerId: string
      requestModelId: string
      catalogMatched: false
      catalogModelId: null
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
