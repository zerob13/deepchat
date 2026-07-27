import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createCatalogSnapshot = (supportsReasoning: boolean) => ({
  modelMatched: supportsReasoning,
  reasoningPortrait: supportsReasoning ? { supported: true } : null,
  supportsReasoning,
  thinkingBudgetRange: {},
  supportsSearch: false,
  searchDefaults: {},
  temperatureCapability: undefined,
  supportsAudioInput: false,
  supportsReasoningEffort: false,
  reasoningEffortDefault: undefined,
  supportsVerbosity: false,
  verbosityDefault: undefined
})

describe('ProviderSettings provider model capability mapping', () => {
  const loadProviderSettings = async () => {
    const { ProviderSettings } = await import('../../../src/main/provider/settings')
    const { modelCapabilities } = await import('../../../src/main/provider/modelCapabilities')
    return { ProviderSettings, modelCapabilities }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves new-api reasoning capability from endpoint type instead of stored default state', async () => {
    const { ProviderSettings, modelCapabilities } = await loadProviderSettings()
    const catalogSnapshot = vi
      .spyOn(modelCapabilities, 'getCatalogCapabilitySnapshot')
      .mockImplementation((providerId, modelId) =>
        createCatalogSnapshot(providerId === 'openai' && modelId === 'gpt-5.4')
      )

    const getProviderModelRouteMetadata = vi.fn()
    const presenter = Object.assign(Object.create(ProviderSettings.prototype), {
      providerModelHelper: {
        getProviderModelRouteMetadata,
        getProviderModels: vi.fn().mockReturnValue([
          {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            group: 'default',
            providerId: 'new-api',
            isCustom: false,
            endpointType: 'openai',
            reasoning: false
          }
        ]),
        getCustomModels: vi.fn().mockReturnValue([])
      },
      getModelConfig: vi.fn().mockReturnValue({ endpointType: undefined })
    }) as InstanceType<typeof ProviderSettings>

    const models = presenter.getProviderModels('new-api')

    expect(models).toEqual([
      expect.objectContaining({
        id: 'gpt-5.4',
        reasoning: true
      })
    ])
    expect(catalogSnapshot).toHaveBeenCalledWith('openai', 'gpt-5.4')
    expect(getProviderModelRouteMetadata).not.toHaveBeenCalled()
    expect(presenter.getModelConfig).not.toHaveBeenCalled()
  })

  it('preserves explicit stored reasoning support when capability registry has no match', async () => {
    const { ProviderSettings, modelCapabilities } = await loadProviderSettings()
    vi.spyOn(modelCapabilities, 'getCatalogCapabilitySnapshot').mockReturnValue(
      createCatalogSnapshot(false)
    )

    const presenter = Object.assign(Object.create(ProviderSettings.prototype), {
      providerModelHelper: {
        getProviderModels: vi.fn().mockReturnValue([
          {
            id: 'vendor-special',
            name: 'Vendor Special',
            group: 'default',
            providerId: 'new-api',
            isCustom: false,
            endpointType: 'openai',
            reasoning: true
          }
        ]),
        getCustomModels: vi.fn().mockReturnValue([])
      },
      getModelConfig: vi.fn().mockReturnValue({ endpointType: undefined })
    }) as InstanceType<typeof ProviderSettings>

    const models = presenter.getProviderModels('new-api')

    expect(models).toEqual([
      expect.objectContaining({
        id: 'vendor-special',
        reasoning: true
      })
    ])
  })

  it('maps routed reasoning capability for new-api-like fork providers from supported endpoints', async () => {
    const { ProviderSettings, modelCapabilities } = await loadProviderSettings()
    const catalogSnapshot = vi
      .spyOn(modelCapabilities, 'getCatalogCapabilitySnapshot')
      .mockImplementation((providerId, modelId) =>
        createCatalogSnapshot(providerId === 'anthropic' && modelId === 'claude-opus-4-7')
      )

    const presenter = Object.assign(Object.create(ProviderSettings.prototype), {
      providerModelHelper: {
        getProviderModels: vi.fn().mockReturnValue([
          {
            id: 'claude-opus-4-7',
            name: 'Claude Opus 4.7',
            group: 'default',
            providerId: 'fork-api',
            isCustom: false,
            supportedEndpointTypes: ['openai-response', 'anthropic'],
            reasoning: false
          }
        ]),
        getCustomModels: vi.fn().mockReturnValue([])
      },
      getModelConfig: vi.fn().mockReturnValue({ endpointType: undefined })
    }) as InstanceType<typeof ProviderSettings>

    const models = presenter.getProviderModels('fork-api')

    expect(models).toEqual([
      expect.objectContaining({
        id: 'claude-opus-4-7',
        reasoning: true
      })
    ])
    expect(catalogSnapshot).toHaveBeenCalledWith('anthropic', 'claude-opus-4-7')
  })

  it('keeps anthropic transport relays on provider-local capability semantics', async () => {
    const { ProviderSettings, modelCapabilities } = await loadProviderSettings()
    const catalogSnapshot = vi
      .spyOn(modelCapabilities, 'getCatalogCapabilitySnapshot')
      .mockImplementation((providerId, modelId) =>
        createCatalogSnapshot(providerId === 'anthropic' && modelId === 'claude-opus-4-7')
      )

    const presenter = Object.assign(Object.create(ProviderSettings.prototype), {
      providerHelper: {
        getProviderById: vi.fn().mockReturnValue({
          id: 'my-anthropic-proxy',
          apiType: 'anthropic'
        })
      },
      providerModelHelper: {
        getProviderModels: vi.fn().mockReturnValue([
          {
            id: 'claude-opus-4-7',
            name: 'Claude Opus 4.7',
            group: 'default',
            providerId: 'my-anthropic-proxy',
            isCustom: false,
            reasoning: false
          }
        ]),
        getCustomModels: vi.fn().mockReturnValue([])
      },
      getModelConfig: vi.fn().mockReturnValue({ endpointType: undefined })
    }) as InstanceType<typeof ProviderSettings>

    const models = presenter.getProviderModels('my-anthropic-proxy')

    expect(models).toEqual([
      expect.objectContaining({
        id: 'claude-opus-4-7',
        reasoning: false
      })
    ])
    expect(catalogSnapshot).not.toHaveBeenCalled()
  })

  it('maps zenmux anthropic routes to anthropic capability semantics', async () => {
    const { ProviderSettings } = await loadProviderSettings()
    const presenter = Object.assign(Object.create(ProviderSettings.prototype), {
      providerHelper: {
        getProviderById: vi.fn().mockReturnValue({
          id: 'zenmux',
          apiType: 'openai'
        })
      },
      providerModelHelper: {
        getProviderModels: vi.fn().mockReturnValue([]),
        getCustomModels: vi.fn().mockReturnValue([])
      },
      getModelConfig: vi.fn().mockReturnValue({ endpointType: undefined }),
      getCustomModels: vi.fn().mockReturnValue([])
    }) as InstanceType<typeof ProviderSettings>

    expect(presenter.getCapabilityProviderId('zenmux', 'anthropic/claude-opus-4-7')).toBe(
      'anthropic'
    )
  })

  it('does not load the full model list when a targeted capability route is absent', async () => {
    const { ProviderSettings } = await loadProviderSettings()
    const getProviderModels = vi.fn().mockReturnValue([])
    const getProviderModelRouteMetadata = vi.fn().mockReturnValue(undefined)
    const modelConfig = { endpointType: undefined }
    const presenter = Object.assign(Object.create(ProviderSettings.prototype), {
      providerHelper: {
        getProviderById: vi.fn().mockReturnValue({
          id: 'custom-relay',
          apiType: 'openai'
        })
      },
      providerModelHelper: {
        getProviderModelRouteMetadata,
        getProviderModels,
        getCustomModels: vi.fn().mockReturnValue([])
      },
      getModelConfig: vi.fn().mockReturnValue(modelConfig)
    }) as InstanceType<typeof ProviderSettings>

    expect(presenter.getCapabilityProviderId('custom-relay', 'unknown-model')).toBe('custom-relay')
    expect(getProviderModelRouteMetadata).toHaveBeenCalledOnce()
    expect(getProviderModelRouteMetadata).toHaveBeenCalledWith(
      'custom-relay',
      'unknown-model',
      modelConfig
    )
    expect(getProviderModels).not.toHaveBeenCalled()
  })
})
