import {
  isClaudeFamilyModelId,
  isDeepSeekSeriesModelId,
  isGeminiFamilyModelId,
  type NewApiEndpointType
} from '@shared/model'
import type {
  CapabilityIdentitySource,
  ResolvedCapabilityIdentity,
  ResolvedModelCapabilitySnapshot
} from '@shared/types/model-capabilities'
import { modelCapabilities, type CapabilityModelMatch } from './modelCapabilities'

export type CapabilityFamilyHint = 'anthropic' | 'gemini'

export type CapabilityIdentityInput = {
  providerId: string
  modelId: string
  ownedBy?: string
  endpointType?: NewApiEndpointType
  explicitProviderId?: string
}

const OPENCODE_GO_ANTHROPIC_MODEL_IDS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus'
])

export const isZenmuxAnthropicRoute = (providerId: string, modelId: string): boolean =>
  providerId.trim().toLowerCase() === 'zenmux' &&
  modelId.trim().toLowerCase().startsWith('anthropic/')

export const isOpenCodeGoAnthropicRoute = (providerId: string, modelId: string): boolean =>
  providerId.trim().toLowerCase() === 'opencode-go' &&
  OPENCODE_GO_ANTHROPIC_MODEL_IDS.has(modelId.trim().toLowerCase())

const normalizeHintValue = (value: string | undefined): string =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/[./_-]+/g, ' ') ?? ''

const normalizeProviderId = (providerId: string): string =>
  modelCapabilities.resolveProviderId(providerId.trim().toLowerCase()) ??
  providerId.trim().toLowerCase()

const addUniqueProviderId = (providerIds: string[], providerId: string): void => {
  const normalizedProviderId = normalizeProviderId(providerId)
  if (normalizedProviderId && !providerIds.includes(normalizedProviderId)) {
    providerIds.push(normalizedProviderId)
  }
}

const getNamespaceProviderIds = (modelId: string): string[] => {
  const normalizedModelId = modelId.trim().toLowerCase()
  const namespace = normalizedModelId.includes('/')
    ? normalizedModelId.slice(0, normalizedModelId.indexOf('/'))
    : undefined
  if (!namespace) {
    return []
  }

  const providerIds: string[] = []
  const mappedProviderId = (
    {
      anthropic: 'anthropic',
      google: 'google',
      gemini: 'google',
      openai: 'openai',
      moonshot: 'moonshot',
      moonshotai: 'moonshot',
      kimi: 'moonshot',
      xai: 'xai',
      'x-ai': 'xai',
      deepseek: 'deepseek',
      qwen: 'alibaba-cn',
      alibaba: 'alibaba-cn',
      dashscope: 'alibaba-cn',
      doubao: 'doubao',
      volcengine: 'doubao',
      bytedance: 'doubao'
    } as Record<string, string>
  )[namespace]

  if (mappedProviderId) {
    addUniqueProviderId(providerIds, mappedProviderId)
  }
  addUniqueProviderId(providerIds, namespace)
  return providerIds
}

const getOwnerProviderIds = (ownedBy: string | undefined): string[] => {
  const owner = normalizeHintValue(ownedBy)
  const providerIds: string[] = []

  if (owner.includes('claude') || owner.includes('anthropic')) {
    addUniqueProviderId(providerIds, 'anthropic')
  }
  if (owner.includes('gemini') || owner.includes('google')) {
    addUniqueProviderId(providerIds, 'google')
  }
  if (owner.includes('moonshot') || owner.includes('kimi')) {
    addUniqueProviderId(providerIds, 'moonshot')
  }
  if (owner.includes('deepseek')) {
    addUniqueProviderId(providerIds, 'deepseek')
  }
  if (owner.includes('xai') || owner.includes('grok')) {
    addUniqueProviderId(providerIds, 'xai')
  }
  if (
    owner === 'ali' ||
    owner.includes('alibaba') ||
    owner.includes('qwen') ||
    owner.includes('dashscope')
  ) {
    addUniqueProviderId(providerIds, 'alibaba-cn')
    addUniqueProviderId(providerIds, 'alibaba')
  }
  if (owner.includes('volcengine') || owner.includes('doubao') || owner.includes('bytedance')) {
    addUniqueProviderId(providerIds, 'doubao')
  }
  if (owner.includes('openai')) {
    addUniqueProviderId(providerIds, 'openai')
  }

  return providerIds
}

const getModelFamilyProviderIds = (modelId: string): string[] => {
  const normalizedModelId = normalizeHintValue(modelId)
  const providerIds: string[] = []

  if (isClaudeFamilyModelId(modelId)) {
    addUniqueProviderId(providerIds, 'anthropic')
  }
  if (isGeminiFamilyModelId(modelId)) {
    addUniqueProviderId(providerIds, 'google')
  }
  if (normalizedModelId.includes('kimi') || normalizedModelId.includes('moonshot')) {
    addUniqueProviderId(providerIds, 'moonshot')
  }
  if (normalizedModelId.includes('qwen') || normalizedModelId.includes('qwq')) {
    addUniqueProviderId(providerIds, 'alibaba-cn')
    addUniqueProviderId(providerIds, 'alibaba')
  }
  if (isDeepSeekSeriesModelId(modelId)) {
    addUniqueProviderId(providerIds, 'deepseek')
  }
  if (normalizedModelId.includes('doubao')) {
    addUniqueProviderId(providerIds, 'doubao')
  }
  if (normalizedModelId.includes('grok') || normalizedModelId.includes('xai')) {
    addUniqueProviderId(providerIds, 'xai')
  }

  return providerIds
}

const getExplicitRouteCapabilityProviderId = (
  providerId: string,
  modelId: string
): string | undefined => {
  if (isZenmuxAnthropicRoute(providerId, modelId)) {
    return 'anthropic'
  }

  if (isOpenCodeGoAnthropicRoute(providerId, modelId)) {
    return 'anthropic'
  }

  return undefined
}

const toMatchedIdentity = (
  match: CapabilityModelMatch,
  source: CapabilityIdentitySource
): ResolvedCapabilityIdentity => ({
  providerId: match.providerId,
  modelId: match.modelId,
  source,
  catalogMatched: true
})

const resolveProviderMatch = (
  providerIds: readonly string[],
  modelId: string,
  source: CapabilityIdentitySource
): ResolvedCapabilityIdentity | undefined => {
  for (const providerId of providerIds) {
    const match = modelCapabilities.getProviderCapabilityModelMatch(providerId, modelId)
    if (match) {
      return toMatchedIdentity(match, source)
    }
  }
  return undefined
}

export const resolveCapabilityFamilyHint = (
  modelId: string,
  ownedBy?: string
): CapabilityFamilyHint | undefined => {
  const normalizedOwner = normalizeHintValue(ownedBy)
  if (
    isClaudeFamilyModelId(modelId) ||
    normalizedOwner.includes('claude') ||
    normalizedOwner.includes('anthropic') ||
    modelCapabilities.getProviderCapabilityModelMatch('anthropic', modelId)
  ) {
    return 'anthropic'
  }

  if (
    isGeminiFamilyModelId(modelId) ||
    normalizedOwner.includes('gemini') ||
    normalizedOwner.includes('google') ||
    modelCapabilities.getProviderCapabilityModelMatch('google', modelId)
  ) {
    return 'gemini'
  }

  return undefined
}

export const resolveTransportCapabilityFallback = (
  providerId: string,
  endpointType?: NewApiEndpointType
): string => {
  switch (endpointType) {
    case 'anthropic':
      return 'anthropic'
    case 'gemini':
      return 'google'
    case 'openai':
    case 'openai-response':
    case 'image-generation':
    case 'video-generation':
      return 'openai'
    default:
      return normalizeProviderId(providerId)
  }
}

export const resolveCapabilityIdentity = (
  input: CapabilityIdentityInput
): ResolvedCapabilityIdentity => {
  const explicitProviderId = input.explicitProviderId?.trim()
  if (explicitProviderId) {
    return (
      resolveProviderMatch([explicitProviderId], input.modelId, 'provider-override') ?? {
        providerId: normalizeProviderId(explicitProviderId),
        modelId: input.modelId,
        source: 'provider-override',
        catalogMatched: false
      }
    )
  }

  const routeOverrideProviderId = getExplicitRouteCapabilityProviderId(
    input.providerId,
    input.modelId
  )
  if (routeOverrideProviderId) {
    return (
      resolveProviderMatch([routeOverrideProviderId], input.modelId, 'route-override') ?? {
        providerId: normalizeProviderId(routeOverrideProviderId),
        modelId: input.modelId,
        source: 'route-override',
        catalogMatched: false
      }
    )
  }

  const providerModelIdentity = resolveProviderMatch(
    [input.providerId],
    input.modelId,
    'provider-model'
  )
  if (providerModelIdentity) {
    return providerModelIdentity
  }

  const identityCandidates: Array<{
    providerIds: string[]
    source: CapabilityIdentitySource
  }> = [
    {
      providerIds: getNamespaceProviderIds(input.modelId),
      source: 'model-namespace'
    },
    {
      providerIds: getOwnerProviderIds(input.ownedBy),
      source: 'model-owner'
    },
    {
      providerIds: getModelFamilyProviderIds(input.modelId),
      source: 'model-family'
    }
  ]

  for (const candidate of identityCandidates) {
    const identity = resolveProviderMatch(candidate.providerIds, input.modelId, candidate.source)
    if (identity) {
      return identity
    }
  }

  const transportProviderId = resolveTransportCapabilityFallback(
    input.providerId,
    input.endpointType
  )
  const transportIdentity = resolveProviderMatch(
    [transportProviderId],
    input.modelId,
    'transport-model'
  )
  if (transportIdentity) {
    return transportIdentity
  }

  const uniqueMatch = modelCapabilities.findUniqueCapabilityModelMatch(input.modelId)
  if (uniqueMatch) {
    return toMatchedIdentity(uniqueMatch, 'unique-model')
  }

  return {
    providerId: transportProviderId,
    modelId: input.modelId,
    source: 'transport-fallback',
    catalogMatched: false
  }
}

export const buildResolvedCapabilitySnapshot = (
  identity: ResolvedCapabilityIdentity
): ResolvedModelCapabilitySnapshot => {
  const catalog = modelCapabilities.getCatalogCapabilitySnapshot(
    identity.providerId,
    identity.modelId
  )

  return {
    identity,
    supportsAudioInput: catalog.supportsAudioInput,
    supportsReasoning: catalog.supportsReasoning,
    reasoningPortrait: catalog.reasoningPortrait,
    thinkingBudgetRange: catalog.thinkingBudgetRange,
    supportsSearch: catalog.supportsSearch,
    searchDefaults: catalog.searchDefaults,
    temperatureCapability: catalog.temperatureCapability,
    supportsTemperatureControl: catalog.temperatureCapability !== false,
    supportsReasoningEffort: catalog.supportsReasoningEffort,
    reasoningEffortDefault: catalog.reasoningEffortDefault,
    supportsVerbosity: catalog.supportsVerbosity,
    verbosityDefault: catalog.verbosityDefault
  }
}
