import { ipcMain, IpcMainInvokeEvent, app } from 'electron'
// import { LlamaCppPresenter } from './llamaCppPresenter'
import { WindowPresenter } from './windowPresenter'
import { SQLitePresenter } from './sqlitePresenter'
import { ShortcutPresenter } from './shortcutPresenter'
import { IPresenter, MODEL_META } from '@shared/presenter'
import { eventBus } from '@/eventbus'
import path from 'path'
import { LLMProviderPresenter } from './llmProviderPresenter'
import { ConfigPresenter } from './configPresenter'
import { ThreadPresenter } from './threadPresenter'
import { DevicePresenter } from './devicePresenter'
import { UpgradePresenter } from './upgradePresenter'
import { SearchPresenter } from './searchPresenter'

export class Presenter implements IPresenter {
  windowPresenter: WindowPresenter
  sqlitePresenter: SQLitePresenter
  llmproviderPresenter: LLMProviderPresenter
  configPresenter: ConfigPresenter
  threadPresenter: ThreadPresenter
  devicePresenter: DevicePresenter
  upgradePresenter: UpgradePresenter
  shortcutPresenter: ShortcutPresenter
  searchPresenter: SearchPresenter
  // llamaCppPresenter: LlamaCppPresenter

  constructor() {
    this.configPresenter = new ConfigPresenter()
    this.windowPresenter = new WindowPresenter(this.configPresenter)
    this.llmproviderPresenter = new LLMProviderPresenter()
    this.devicePresenter = new DevicePresenter()
    // 初始化 SQLite 数据库
    const dbDir = path.join(app.getPath('userData'), 'app_db')
    const dbPath = path.join(dbDir, 'chat.db')
    this.sqlitePresenter = new SQLitePresenter(dbPath)
    this.threadPresenter = new ThreadPresenter(this.sqlitePresenter, this.llmproviderPresenter)
    this.upgradePresenter = new UpgradePresenter()
    this.shortcutPresenter = new ShortcutPresenter(this.windowPresenter, this.configPresenter)
    this.searchPresenter = new SearchPresenter()
    // this.llamaCppPresenter = new LlamaCppPresenter()
    this.setupEventBus()
  }
  setupEventBus() {
    eventBus.on('main-window-ready-to-show', () => {
      this.init()
      setTimeout(() => {
        this.upgradePresenter.checkUpdate()
      }, 30000)
    })
    eventBus.on('provider-setting-changed', () => {
      const providers = this.configPresenter.getProviders()
      this.llmproviderPresenter.setProviders(providers)
      this.windowPresenter.mainWindow?.webContents.send('provider-setting-changed')
    })
    eventBus.on('stream-response', (msg) => {
      // console.log('stream-response', msg.eventId, msg)
      this.windowPresenter.mainWindow?.webContents.send('stream-response', msg)
    })
    eventBus.on('stream-end', (msg) => {
      console.log('stream-end', msg.eventId)
      this.windowPresenter.mainWindow?.webContents.send('stream-end', msg)
    })
    eventBus.on('stream-error', (msg) => {
      this.windowPresenter.mainWindow?.webContents.send('stream-error', msg)
    })
    eventBus.on('conversation-activated', (msg) => {
      this.windowPresenter.mainWindow?.webContents.send('conversation-activated', msg)
    })
    eventBus.on('active-conversation-cleared', (msg) => {
      this.windowPresenter.mainWindow?.webContents.send('active-conversation-cleared', msg)
    })
    eventBus.on('provider-models-updated', (msg: { providerId: string; models: MODEL_META[] }) => {
      // 当模型列表更新时，保存自定义模型
      const customModels = msg.models.filter((model) => model.isCustom)
      this.configPresenter.setCustomModels(msg.providerId, customModels)
      const providerModels = msg.models.filter((model) => !model.isCustom)
      this.configPresenter.setProviderModels(msg.providerId, providerModels)
      // 转发事件到渲染进程
      this.windowPresenter.mainWindow?.webContents.send('provider-models-updated')
    })
    eventBus.on('update-status-changed', (msg) => {
      console.log('update-status-changed', msg)
      this.windowPresenter.mainWindow?.webContents.send('update-status-changed', msg)
    })
  }

  init() {
    if (this.windowPresenter.mainWindow) {
      // this.llamaCppPresenter.setMainwindow(this.windowPresenter.mainWindow)
      this.searchPresenter.init() // 在主窗口准备好后初始化 SearchPresenter
    }
    // 持久化 LLMProviderPresenter 的 Providers 数据
    const providers = this.configPresenter.getProviders()
    this.llmproviderPresenter.setProviders(providers)

    // 同步所有 provider 的自定义模型
    this.syncCustomModels()
  }

  private async syncCustomModels() {
    const providers = this.configPresenter.getProviders()
    for (const provider of providers) {
      if (provider.enable) {
        const customModels = this.configPresenter.getCustomModels(provider.id)
        for (const model of customModels) {
          await this.llmproviderPresenter.addCustomModel(provider.id, {
            id: model.id,
            name: model.name,
            enabled: model.enabled,
            contextLength: model.contextLength,
            maxTokens: model.maxTokens
          })
        }
      }
    }
  }

  // 在应用退出时关闭数据库连接
  destroy() {
    this.sqlitePresenter.close()
    this.shortcutPresenter.destroy()
    this.searchPresenter.destroy()
  }
}

export const presenter = new Presenter()
ipcMain.handle(
  'presenter:call',
  (_event: IpcMainInvokeEvent, name: string, method: string, ...payloads: unknown[]) => {
    try {
      const calledPresenter = presenter[name]
      if (!calledPresenter) {
        console.warn('calling wrong presenter', name)
        return
      }
      if (!calledPresenter[method]) {
        console.warn('calling wrong presenter method', name, method)
        return
      }
      return calledPresenter[method](...payloads)
    } catch (e) {
      console.warn('error on presenter handle', e)
      return null
    }
  }
)
