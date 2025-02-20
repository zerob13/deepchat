import { eventBus } from '@/eventbus'
import { IConfigPresenter, LLM_PROVIDER, MODEL_META } from '@shared/presenter'
import ElectronStore from 'electron-store'
import { DEFAULT_PROVIDERS } from './providers'

// 定义应用设置的接口
interface IAppSettings {
  // 在这里定义你的配置项，例如：
  language: string
  providers: LLM_PROVIDER[]
  closeToQuit: boolean // 是否点击关闭按钮时退出程序
}

const defaultProviders = DEFAULT_PROVIDERS.map((provider) => ({
  id: provider.id,
  name: provider.name,
  apiType: provider.apiType,
  apiKey: provider.apiKey,
  baseUrl: provider.baseUrl,
  enable: provider.enable
}))

// 定义 storeKey 常量
const PROVIDERS_STORE_KEY = 'providers'
const CUSTOM_MODELS_KEY = 'custom_models'

export class ConfigPresenter implements IConfigPresenter {
  private store: ElectronStore<IAppSettings>

  constructor() {
    this.store = new ElectronStore<IAppSettings>({
      name: 'app-settings',
      watch: true
    })
    const existingProviders = this.getSetting<LLM_PROVIDER[]>(PROVIDERS_STORE_KEY) || []
    const newProviders = defaultProviders.filter(
      (defaultProvider) =>
        !existingProviders.some((existingProvider) => existingProvider.id === defaultProvider.id)
    )

    if (newProviders.length > 0) {
      this.setProviders([...existingProviders, ...newProviders])
    }
  }

  getSetting<T>(key: string): T | undefined {
    try {
      return this.store.get(key) as T
    } catch (error) {
      console.error(`[Config] Failed to get setting ${key}:`, error)
      return undefined
    }
  }

  setSetting<T>(key: string, value: T): void {
    try {
      this.store.set(key, value)
    } catch (error) {
      console.error(`[Config] Failed to set setting ${key}:`, error)
    }
  }

  getProviders(): LLM_PROVIDER[] {
    const providers = this.getSetting<LLM_PROVIDER[]>(PROVIDERS_STORE_KEY)
    if (Array.isArray(providers) && providers.length > 0) {
      return providers
    } else {
      this.setSetting(PROVIDERS_STORE_KEY, defaultProviders)
      return defaultProviders
    }
  }

  setProviders(providers: LLM_PROVIDER[]): void {
    this.setSetting<LLM_PROVIDER[]>(PROVIDERS_STORE_KEY, providers)
    eventBus.emit('provider-setting-changed')
  }

  getProviderById(id: string): LLM_PROVIDER | undefined {
    const providers = this.getProviders()
    return providers.find((provider) => provider.id === id)
  }

  setProviderById(id: string, provider: LLM_PROVIDER): void {
    const providers = this.getProviders()
    const index = providers.findIndex((p) => p.id === id)
    if (index !== -1) {
      providers[index] = provider
      this.setProviders(providers)
    } else {
      console.error(`[Config] Provider ${id} not found`)
    }
  }

  getProviderModels(providerId: string): MODEL_META[] {
    const key = `${providerId}_models`
    return this.getSetting<MODEL_META[]>(key) || []
  }

  setProviderModels(providerId: string, models: MODEL_META[]): void {
    const key = `${providerId}_models`
    this.setSetting(key, models)
  }

  getEnabledProviders(): LLM_PROVIDER[] {
    const providers = this.getProviders()
    return providers.filter((provider) => provider.enable)
  }

  getAllEnabledModels(): Promise<{ providerId: string; models: MODEL_META[] }[]> {
    const enabledProviders = this.getEnabledProviders()
    return Promise.all(
      enabledProviders.map(async (provider) => ({
        providerId: provider.id,
        models: [
          ...this.getProviderModels(provider.id).filter((model) => model.enabled),
          ...this.getCustomModels(provider.id).filter((model) => model.enabled)
        ]
      }))
    )
  }

  getCustomModels(providerId: string): MODEL_META[] {
    const key = `${CUSTOM_MODELS_KEY}_${providerId}`
    return this.getSetting<MODEL_META[]>(key) || []
  }

  setCustomModels(providerId: string, models: MODEL_META[]): void {
    const key = `${CUSTOM_MODELS_KEY}_${providerId}`
    this.setSetting(key, models)
  }

  addCustomModel(providerId: string, model: MODEL_META): void {
    const models = this.getCustomModels(providerId)
    const existingIndex = models.findIndex((m) => m.id === model.id)

    if (existingIndex !== -1) {
      models[existingIndex] = model
    } else {
      models.push(model)
    }

    this.setCustomModels(providerId, models)
  }

  removeCustomModel(providerId: string, modelId: string): void {
    const models = this.getCustomModels(providerId)
    const filteredModels = models.filter((m) => m.id !== modelId)
    this.setCustomModels(providerId, filteredModels)
  }

  updateCustomModel(providerId: string, modelId: string, updates: Partial<MODEL_META>): void {
    const models = this.getCustomModels(providerId)
    const modelIndex = models.findIndex((m) => m.id === modelId)

    if (modelIndex !== -1) {
      models[modelIndex] = { ...models[modelIndex], ...updates }
      this.setCustomModels(providerId, models)
    }
  }

  getCloseToQuit(): boolean {
    return this.getSetting<boolean>('closeToQuit') ?? false
  }

  setCloseToQuit(value: boolean): void {
    this.setSetting('closeToQuit', value)
  }
}
