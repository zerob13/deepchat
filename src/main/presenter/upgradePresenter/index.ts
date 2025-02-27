import electronUpdater from 'electron-updater'
import { app } from 'electron'
import { IUpgradePresenter, UpdateStatus, UpdateProgress } from '@shared/presenter'
import { eventBus } from '@/eventbus'
import { UPDATE_EVENTS } from '@/events'

const { autoUpdater } = electronUpdater

const getUpdateFeedBaseUrl = () => {
  const platform = process.platform
  const arch = process.arch
  let platformString = ''

  if (platform === 'win32') {
    platformString = arch === 'arm64' ? 'winarm' : 'winx64'
  } else if (platform === 'darwin') {
    platformString = arch === 'arm64' ? 'macarm' : 'macx64'
  } else if (platform === 'linux') {
    platformString = arch === 'arm64' ? 'linuxarm' : 'linuxx64'
  }
  return `https://deepchat.thinkinai.xyz/auth/${platformString}/`
  // console.log(`https://deepchat.thinkinai.xyz/auth/${platformString}/`)
  // return 'http://127.0.0.1:8080/'
}

export class UpgradePresenter implements IUpgradePresenter {
  private _lock: boolean = false
  private _status: UpdateStatus = 'not-available'
  private _progress: UpdateProgress | null = null
  private _error: string | null = null
  private _updateInfo: electronUpdater.UpdateInfo | null = null

  constructor() {
    const feedUrl = getUpdateFeedBaseUrl()
    autoUpdater.setFeedURL(feedUrl)
    // autoUpdater.checkForUpdatesAndNotify()
    autoUpdater.autoDownload = true
    autoUpdater.allowDowngrade = false
    autoUpdater.autoInstallOnAppQuit = true

    // 错误处理
    autoUpdater.on('error', (e) => {
      console.log('check update failed', e.message)
      this._lock = false
      this._status = 'error'
      this._error = e.message
      eventBus.emit(UPDATE_EVENTS.STATUS_CHANGED, {
        status: this._status,
        error: this._error
      })
    })

    // 检查更新状态
    autoUpdater.on('checking-for-update', () => {
      console.log('checking-for-update')
      this._status = 'checking'
      eventBus.emit(UPDATE_EVENTS.STATUS_CHANGED, { status: this._status })
    })

    // 无可用更新
    autoUpdater.on('update-not-available', () => {
      console.log('update-not-available')
      this._lock = false
      this._status = 'not-available'
      eventBus.emit(UPDATE_EVENTS.STATUS_CHANGED, { status: this._status })
    })

    // 有可用更新
    autoUpdater.on('update-available', (info) => {
      this._status = 'available'
      this._updateInfo = info
      eventBus.emit(UPDATE_EVENTS.STATUS_CHANGED, {
        status: this._status,
        info: {
          version: info.version,
          releaseDate: info.releaseDate,
          releaseNotes: info.releaseNotes
        }
      })
    })

    // 下载进度
    autoUpdater.on('download-progress', (progressObj) => {
      this._lock = true
      this._status = 'downloading'
      this._progress = {
        bytesPerSecond: progressObj.bytesPerSecond,
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total
      }
      eventBus.emit(UPDATE_EVENTS.PROGRESS, this._progress)
    })

    // 下载完成
    autoUpdater.on('update-downloaded', (info) => {
      this._lock = false
      this._status = 'downloaded'
      this._updateInfo = info
      eventBus.emit(UPDATE_EVENTS.STATUS_CHANGED, {
        status: this._status,
        info: {
          version: info.version,
          releaseDate: info.releaseDate,
          releaseNotes: info.releaseNotes
        }
      })
    })
  }
  async checkUpdate() {
    if (this._lock) {
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (error: Error | unknown) {
      this._status = 'error'
      this._error = error instanceof Error ? error.message : String(error)
    }
  }
  startDownloadUpdate() {
    if (this._status !== 'available') {
      return false
    }
    try {
      autoUpdater.downloadUpdate()
      return true
    } catch (error: Error | unknown) {
      this._status = 'error'
      this._error = error instanceof Error ? error.message : String(error)
      eventBus.emit(UPDATE_EVENTS.STATUS_CHANGED, {
        status: this._status,
        error: this._error
      })
      return false
    }
  }
  _doQuitAndInstall() {
    console.log('try to quit and install')
    try {
      // 发送即将重启的消息
      eventBus.emit(UPDATE_EVENTS.WILL_RESTART)
      // 通知需要完全退出应用
      eventBus.emit(UPDATE_EVENTS.FORCE_QUIT_APP)
      autoUpdater.quitAndInstall()
      // 如果30s还没完成，就强制退出重启
      setTimeout(() => {
        app.quit()
      }, 30151)
    } catch (e) {
      console.error('Failed to quit and install', e)
      eventBus.emit(UPDATE_EVENTS.ERROR, {
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  restartToUpdate() {
    console.log('Restarting update')
    if (this._status !== 'downloaded') {
      eventBus.emit(UPDATE_EVENTS.ERROR, {
        error: '更新尚未下载完成'
      })
      return false
    }
    try {
      this._doQuitAndInstall()
      return true
    } catch (e) {
      console.error('Failed to restart update', e)
      eventBus.emit(UPDATE_EVENTS.ERROR, {
        error: e instanceof Error ? e.message : String(e)
      })
      return false
    }
  }

  restartApp() {
    try {
      // 发送即将重启的消息
      eventBus.emit(UPDATE_EVENTS.WILL_RESTART)
      // 给UI层一点时间保存状态
      setTimeout(() => {
        app.relaunch()
        app.exit()
      }, 1000)
    } catch (e) {
      console.error('Failed to restart', e)
      eventBus.emit(UPDATE_EVENTS.ERROR, {
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  getUpdateStatus() {
    return {
      status: this._status,
      progress: this._progress,
      error: this._error,
      updateInfo: this._updateInfo
        ? {
            version: this._updateInfo.version || '',
            releaseDate: this._updateInfo.releaseDate || '',
            releaseNotes: this._updateInfo.releaseNotes || ''
          }
        : null
    }
  }
}
