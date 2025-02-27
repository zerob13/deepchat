import { eventBus } from '@/eventbus'
import { IConfigPresenter, LLM_PROVIDER, MODEL_META, RENDERER_MODEL_META } from '@shared/presenter'
import ElectronStore from 'electron-store'
import { DEFAULT_PROVIDERS } from './providers'
import { getModelConfig } from '../llmProviderPresenter/modelConfigs'
import path from 'path'
import { app } from 'electron'
import fs from 'fs'
import { CONFIG_EVENTS } from '@/events'

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
// 模型状态键前缀
const MODEL_STATUS_KEY_PREFIX = 'model_status_'

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

  // 构造模型状态的存储键
  private getModelStatusKey(providerId: string, modelId: string): string {
    return `${MODEL_STATUS_KEY_PREFIX}${providerId}_${modelId}`
  }

  // 获取模型启用状态
  getModelStatus(providerId: string, modelId: string): boolean {
    const statusKey = this.getModelStatusKey(providerId, modelId)
    return this.getSetting<boolean>(statusKey) ?? false
  }

  // 设置模型启用状态
  setModelStatus(providerId: string, modelId: string, enabled: boolean): void {
    const statusKey = this.getModelStatusKey(providerId, modelId)
    this.setSetting(statusKey, enabled)
    // 触发模型状态变更事件
    eventBus.emit(CONFIG_EVENTS.MODEL_STATUS_CHANGED, providerId, modelId, enabled)
  }

  // 启用模型
  enableModel(providerId: string, modelId: string): void {
    this.setModelStatus(providerId, modelId, true)
  }

  // 禁用模型
  disableModel(providerId: string, modelId: string): void {
    this.setModelStatus(providerId, modelId, false)
  }

  // 批量设置模型状态
  batchSetModelStatus(providerId: string, modelStatusMap: Record<string, boolean>): void {
    for (const [modelId, enabled] of Object.entries(modelStatusMap)) {
      this.setModelStatus(providerId, modelId, enabled)
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

  getAllEnabledModels(): Promise<{ providerId: string; models: RENDERER_MODEL_META[] }[]> {
    const enabledProviders = this.getEnabledProviders()
    return Promise.all(
      enabledProviders.map(async (provider) => {
        const providerId = provider.id
        const allModels = [
          ...this.getProviderModels(providerId),
          ...this.getCustomModels(providerId)
        ]

        // 根据单独存储的状态过滤启用的模型
        const enabledModels = allModels
          .filter((model) => this.getModelStatus(providerId, model.id))
          .map((model) => ({
            ...model,
            enabled: true
          }))

        return {
          providerId,
          models: enabledModels
        }
      })
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

    // 创建不包含enabled属性的模型副本
    const modelWithoutStatus: MODEL_META = { ...model }
    // @ts-ignore - 需要删除enabled属性以便独立存储状态
    delete modelWithoutStatus.enabled

    if (existingIndex !== -1) {
      models[existingIndex] = modelWithoutStatus as MODEL_META
    } else {
      models.push(modelWithoutStatus as MODEL_META)
    }

    this.setCustomModels(providerId, models)
    // 单独设置模型状态
    this.setModelStatus(providerId, model.id, true)
    // 触发模型列表变更事件
    eventBus.emit(CONFIG_EVENTS.MODEL_LIST_CHANGED, providerId)
  }

  removeCustomModel(providerId: string, modelId: string): void {
    const models = this.getCustomModels(providerId)
    const filteredModels = models.filter((model) => model.id !== modelId)
    this.setCustomModels(providerId, filteredModels)

    // 删除模型状态
    const statusKey = this.getModelStatusKey(providerId, modelId)
    this.store.delete(statusKey)

    // 触发模型列表变更事件
    eventBus.emit(CONFIG_EVENTS.MODEL_LIST_CHANGED, providerId)
  }

  updateCustomModel(providerId: string, modelId: string, updates: Partial<MODEL_META>): void {
    const models = this.getCustomModels(providerId)
    const index = models.findIndex((model) => model.id === modelId)

    if (index !== -1) {
      Object.assign(models[index], updates)
      this.setCustomModels(providerId, models)
      eventBus.emit(CONFIG_EVENTS.MODEL_LIST_CHANGED, providerId)
    }
  }

  getCloseToQuit(): boolean {
    return this.getSetting<boolean>('closeToQuit') ?? false
  }

  setCloseToQuit(value: boolean): void {
    this.setSetting('closeToQuit', value)
  }
}
