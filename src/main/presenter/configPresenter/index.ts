import { eventBus } from '@/eventbus'
import { IConfigPresenter, LLM_PROVIDER, MODEL_META } from '@shared/presenter'
import ElectronStore from 'electron-store'
import { DEFAULT_PROVIDERS } from './providers'
import { getModelConfig } from '../llmProviderPresenter/modelConfigs'
import path from 'path'
import { app } from 'electron'
import fs from 'fs'
import { CONFIG_EVENTS, LEGACY_EVENTS } from '@/events'

// 定义应用设置的接口
interface IAppSettings {
  // 在这里定义你的配置项，例如：
  language: string
  providers: LLM_PROVIDER[]
  closeToQuit: boolean // 是否点击关闭按钮时退出程序
  [key: string]: unknown // 允许任意键，使用unknown类型替代any
}

// 为模型存储创建接口
interface IModelStore {
  models: MODEL_META[]
  custom_models: MODEL_META[]
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
const PROVIDER_MODELS_DIR = 'provider_models'

export class ConfigPresenter implements IConfigPresenter {
  private store: ElectronStore<IAppSettings>
  private providersModelStores: Map<string, ElectronStore<IModelStore>> = new Map()
  private userDataPath: string

  constructor() {
    this.store = new ElectronStore<IAppSettings>({
      name: 'app-settings',
      watch: true
    })

    this.userDataPath = app.getPath('userData')
    this.initProviderModelsDir()

    const existingProviders = this.getSetting<LLM_PROVIDER[]>(PROVIDERS_STORE_KEY) || []
    const newProviders = defaultProviders.filter(
      (defaultProvider) =>
        !existingProviders.some((existingProvider) => existingProvider.id === defaultProvider.id)
    )

    if (newProviders.length > 0) {
      this.setProviders([...existingProviders, ...newProviders])
    }

    // 迁移旧的模型数据
    this.migrateModelData()
  }

  private initProviderModelsDir(): void {
    const modelsDir = path.join(this.userDataPath, PROVIDER_MODELS_DIR)
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true })
    }
  }

  private getProviderModelStore(providerId: string): ElectronStore<IModelStore> {
    if (!this.providersModelStores.has(providerId)) {
      const store = new ElectronStore<IModelStore>({
        name: `models_${providerId}`,
        cwd: path.join(this.userDataPath, PROVIDER_MODELS_DIR),
        defaults: {
          models: [],
          custom_models: []
        }
      })
      this.providersModelStores.set(providerId, store)
    }
    return this.providersModelStores.get(providerId)!
  }

  private migrateModelData(): void {
    // 迁移旧的模型数据
    const providers = this.getProviders()

    for (const provider of providers) {
      // 迁移provider模型
      const oldProviderModelsKey = `${provider.id}_models`
      const oldModels = this.getSetting<MODEL_META[]>(oldProviderModelsKey)

      if (oldModels && oldModels.length > 0) {
        const store = this.getProviderModelStore(provider.id)
        // 保存模型列表到新存储
        store.set('models', oldModels)
        // 清除旧存储
        this.store.delete(oldProviderModelsKey)
      }

      // 迁移custom模型
      const oldCustomModelsKey = `${CUSTOM_MODELS_KEY}_${provider.id}`
      const oldCustomModels = this.getSetting<MODEL_META[]>(oldCustomModelsKey)

      if (oldCustomModels && oldCustomModels.length > 0) {
        const store = this.getProviderModelStore(provider.id)
        // 保存自定义模型列表到新存储
        store.set('custom_models', oldCustomModels)
        // 清除旧存储
        this.store.delete(oldCustomModelsKey)
      }
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
    // 触发新事件
    eventBus.emit(CONFIG_EVENTS.PROVIDER_CHANGED)
    // 兼容旧事件
    eventBus.emit(LEGACY_EVENTS.PROVIDER_SETTING_CHANGED)
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
    const store = this.getProviderModelStore(providerId)
    let models = store.get('models') || []

    models = models.map((model) => {
      const config = getModelConfig(model.id)
      if (config) {
        model.maxTokens = config.maxTokens
        model.contextLength = config.contextLength
      }
      return model
    })
    return models
  }

  setProviderModels(providerId: string, models: MODEL_META[]): void {
    const store = this.getProviderModelStore(providerId)
    store.set('models', models)
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
    const store = this.getProviderModelStore(providerId)
    return store.get('custom_models') || []
  }

  setCustomModels(providerId: string, models: MODEL_META[]): void {
    const store = this.getProviderModelStore(providerId)
    store.set('custom_models', models)
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
    // 触发新事件
    eventBus.emit(CONFIG_EVENTS.MODEL_LIST_CHANGED, providerId)
    // 兼容旧事件
    eventBus.emit(LEGACY_EVENTS.PROVIDER_MODELS_UPDATED, providerId)
  }

  removeCustomModel(providerId: string, modelId: string): void {
    const models = this.getCustomModels(providerId)
    const filteredModels = models.filter((model) => model.id !== modelId)
    this.setCustomModels(providerId, filteredModels)
    // 触发新事件
    eventBus.emit(CONFIG_EVENTS.MODEL_LIST_CHANGED, providerId)
    // 兼容旧事件
    eventBus.emit(LEGACY_EVENTS.PROVIDER_MODELS_UPDATED, providerId)
  }

  updateCustomModel(providerId: string, modelId: string, updates: Partial<MODEL_META>): void {
    const models = this.getCustomModels(providerId)
    const index = models.findIndex((model) => model.id === modelId)
    if (index !== -1) {
      // 检查更新是否仅包含enabled属性
      if (
        Object.keys(updates).length === 1 &&
        Object.prototype.hasOwnProperty.call(updates, 'enabled')
      ) {
        models[index].enabled = updates.enabled as boolean
        this.setCustomModels(providerId, models)
        // 只有enable状态更改时使用model-status-changed事件
        eventBus.emit(LEGACY_EVENTS.MODEL_STATUS_CHANGED, providerId, modelId, updates.enabled)
      } else {
        // 其他属性变更使用provider-models-updated事件
        Object.assign(models[index], updates)
        this.setCustomModels(providerId, models)
        // 触发新事件
        eventBus.emit(CONFIG_EVENTS.MODEL_LIST_CHANGED, providerId)
        // 兼容旧事件
        eventBus.emit(LEGACY_EVENTS.PROVIDER_MODELS_UPDATED, providerId)
      }
    }
  }

  getCloseToQuit(): boolean {
    return this.getSetting<boolean>('closeToQuit') ?? false
  }

  setCloseToQuit(value: boolean): void {
    this.setSetting('closeToQuit', value)
  }
}
