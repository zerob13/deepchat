import { BrowserWindow, shell, app } from 'electron'
import { join } from 'path'
import icon from '../../../resources/icon.png?asset'
import iconWin from '../../../resources/icon.ico?asset'
import { is } from '@electron-toolkit/utils'
import { IWindowPresenter } from '@shared/presenter'
import { eventBus } from '@/eventbus'
import { ConfigPresenter } from './configPresenter'
import { TrayPresenter } from './trayPresenter'

export const MAIN_WIN = 'main'
export class WindowPresenter implements IWindowPresenter {
  windows: Map<string, BrowserWindow>
  private configPresenter: ConfigPresenter
  private isQuitting: boolean = false
  private trayPresenter: TrayPresenter | null = null

  constructor(configPresenter: ConfigPresenter) {
    this.windows = new Map()
    this.configPresenter = configPresenter

    // 检查是否为第二个实例
    const gotTheLock = app.requestSingleInstanceLock()
    if (!gotTheLock) {
      app.quit()
      return
    }

    // 处理第二个实例的启动
    app.on('second-instance', () => {
      const mainWindow = this.mainWindow
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
      }
    })

    // 监听应用退出事件
    app.on('before-quit', () => {
      console.log('before-quit')
      this.isQuitting = true
      if (this.trayPresenter) {
        this.trayPresenter.destroy()
      }
    })

    // 监听强制退出事件
    eventBus.on('force-quit-app', () => {
      console.log('force-quit-app')
      this.isQuitting = true
      if (this.trayPresenter) {
        this.trayPresenter.destroy()
      }
    })

    console.log('WindowPresenter constructor', this.configPresenter)
  }

  createMainWindow(): BrowserWindow {
    const mainWindow = new BrowserWindow({
      width: 1024,
      height: 620,
      show: false,
      autoHideMenuBar: true,
      icon: process.platform === 'win32' ? iconWin : icon,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: {
        x: 8,
        y: 10
      },
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        sandbox: false,
        devTools: is.dev
      },
      frame: false
    })

    mainWindow.on('ready-to-show', () => {
      mainWindow.show()
      eventBus.emit('main-window-ready-to-show', mainWindow)
    })

    // 处理关闭按钮点击
    mainWindow.on('close', (e) => {
      eventBus.emit('main-window-close', mainWindow)
      console.log('main-window-close', this.isQuitting, e)
      if (!this.isQuitting) {
        e.preventDefault()
        if (mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
        }
        mainWindow.hide()
      }
    })

    mainWindow.on('closed', () => {
      this.windows.delete(MAIN_WIN)
      eventBus.emit('main-window-closed', mainWindow)
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    // Add handler for regular link clicks
    mainWindow.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      shell.openExternal(url)
    })

    mainWindow.on('show', () => {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
    })

    if (is.dev) {
      mainWindow.webContents.openDevTools()
    }

    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
    this.windows.set(MAIN_WIN, mainWindow)

    // 初始化托盘
    if (!this.trayPresenter) {
      this.trayPresenter = new TrayPresenter(this)
    }

    return mainWindow
  }
  getWindow(windowName: string): BrowserWindow | undefined {
    return this.windows.get(windowName)
  }

  get mainWindow(): BrowserWindow | undefined {
    return this.getWindow(MAIN_WIN)
  }

  minimize(): void {
    const window = this.mainWindow
    if (window) {
      window.minimize()
    }
  }

  maximize(): void {
    const window = this.mainWindow
    if (window) {
      if (window.isMaximized()) {
        window.unmaximize()
      } else {
        window.maximize()
      }
    }
  }

  close(): void {
    const window = this.mainWindow
    if (window) {
      window.close()
    }
  }

  hide(): void {
    const window = this.mainWindow
    if (window) {
      window.hide()
    }
  }

  show(): void {
    const window = this.mainWindow
    if (window) {
      window.show()
    }
  }

  isMaximized(): boolean {
    const window = this.mainWindow
    return window ? window.isMaximized() : false
  }
}
