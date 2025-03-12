import { app, BrowserWindow, screen } from 'electron'
import path from 'path'
import { SearchEngineTemplate } from '@shared/chat'
import { ContentEnricher } from './contentEnricher'
import { SearchResult } from '@shared/presenter'
import { is } from '@electron-toolkit/utils'
import { presenter } from '@/presenter'
import { MAIN_WIN } from '../windowPresenter'

const helperPage = path.join(app.getAppPath(), 'resources', 'blankSearch.html')

const defaultEngines: SearchEngineTemplate[] = [
  {
    name: 'sogou',
    selector: '.news-list',
    searchUrl:
      'https://weixin.sogou.com/weixin?ie=utf8&s_from=input&_sug_=y&_sug_type_=&type=2&query={query}',
    extractorScript: `
      const results = []
      const items = document.querySelectorAll('.news-list li')
      items.forEach((item, index) => {
        const titleEl = item.querySelector('h3 a')
        const linkEl = item.querySelector('h3 a')
        const descEl = item.querySelector('p.txt-info')
        const faviconEl = item.querySelector('a[data-z="art"] img')
        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent,
            url: linkEl.href,
            rank: index + 1,
            description: descEl ? descEl.textContent : '',
            icon: faviconEl ? faviconEl.src : ''
          })
        }
      })
      return results
    `
  },
  {
    name: 'google',
    selector: '#search',
    searchUrl: 'https://www.google.com/search?q={query}',
    extractorScript: `
      const results = []
      const items = document.querySelectorAll('#search .g')
      items.forEach((item, index) => {
        const titleEl = item.querySelector('h3')
        const linkEl = item.querySelector('a')
        const descEl = item.querySelector('.VwiC3b')
        const faviconEl = item.querySelector('img.XNo5Ab')
        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent,
            url: linkEl.href,
            rank: index + 1,
            description: descEl ? descEl.textContent : '',
            icon: faviconEl ? faviconEl.src : ''
          })
        }
      })
      return results
    `
  },
  {
    name: 'baidu',
    selector: '#content_left',
    searchUrl: 'https://www.baidu.com/s?wd={query}',
    extractorScript: `
      const results = []
      const items = document.querySelectorAll('#content_left .result')
      items.forEach((item, index) => {
        const titleEl = item.querySelector('.t')
        const linkEl = item.querySelector('a')
        const descEl = item.querySelector('.c-abstract')
        const faviconEl = item.querySelector('.c-img')
        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent,
            url: linkEl.href,
            rank: index + 1,
            description: descEl ? descEl.textContent : '',
            icon: faviconEl ? faviconEl.getAttribute('src') : ''
          })
        }
      })
      return results
    `
  },
  {
    name: 'bing',
    selector: '',
    searchUrl: 'https://www.bing.com/search?q={query}',
    extractorScript: `
      const results = []
      const items = document.querySelectorAll('#b_content .b_algo')
      items.forEach((item, index) => {
        const titleEl = item.querySelector('h2 a')
        const linkEl = item.querySelector('h2 a')
        const descEl = item.querySelector('.b_caption p')
        const faviconEl = item.querySelector('.wr_fav img')
        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent,
            url: linkEl.href,
            rank: index + 1,
            description: descEl ? descEl.textContent : '',
            icon: faviconEl?.src ? faviconEl.src : ''
          })
        }
      })
      return results
    `
  },
  {
    name: 'google-scholar',
    selector: '#gs_res_ccl',
    searchUrl: 'https://scholar.google.com/scholar?q={query}',
    extractorScript: `
      const results = []
      const items = document.querySelectorAll('.gs_r')
      items.forEach((item, index) => {
        const titleEl = item.querySelector('.gs_rt')
        const linkEl = item.querySelector('.gs_rt a')
        const descEl = item.querySelector('.gs_rs')
        const faviconEl = item.querySelector('.gs_rt img')
        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent,
            url: linkEl.href,
            rank: index + 1,
            description: descEl ? descEl.textContent : '',
            icon: faviconEl ? faviconEl.src : ''
          })
        }
      })
      return results
    `
  },
  {
    name: 'baidu-xueshu',
    selector: '#bdxs_result_lists',
    searchUrl: 'https://xueshu.baidu.com/s?wd={query}',
    extractorScript: `
      const results = []
      const items = document.querySelectorAll('#bdxs_result_lists .sc_default_result')
      items.forEach((item, index) => {
        const titleEl = item.querySelector('.sc_content .t')
        const linkEl = item.querySelector('.sc_content a')
        const descEl = item.querySelector('.c_abstract')
        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent?.trim(),
            url: linkEl.href,
            rank: index + 1,
            description: descEl ? descEl.textContent?.trim() : '',
            icon:  ''
          })
        }
      })
      return results
    `
  },
  {
    name: 'duckduckgo',
    selector: 'button.cxQwADb9kt3UnKwcXKat',
    searchUrl: 'https://duckduckgo.com/?q={query}',
    extractorScript: `
      const results = []
      const items = document.querySelectorAll('article.yQDlj3B5DI5YO8c8Ulio')
      items.forEach((item, index) => {
        const titleEl = item.querySelector('.EKtkFWMYpwzMKOYr0GYm.LQVY1Jpkk8nyJ6HBWKAk')
        const linkEl = item.querySelector('a')
        const descEl = item.querySelector('.E2eLOJr8HctVnDOTM8fs')
        const icon = item.querySelector('.DpVR46dTZaePK29PDkz8 img')
        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent,
            url: linkEl.href,
            rank: index + 1,
            description: descEl ? descEl.textContent : '',
            icon: icon ? icon.src : ''
          })
        }
      })
      return results
    `
  }
]

export class SearchManager {
  private searchWindows: Map<string, BrowserWindow> = new Map()
  private maxConcurrentSearches = 3
  private engines: SearchEngineTemplate[] = defaultEngines
  private activeEngine: SearchEngineTemplate = this.engines[0]
  private originalWindowSizes: Map<string, { width: number; height: number }> = new Map()
  private originalWindowPositions: Map<string, { x: number; y: number }> = new Map()
  private wasFullScreen: Map<string, boolean> = new Map()
  private searchWindowWidth = 800
  private abortControllers: Map<string, AbortController> = new Map()
  constructor() {}

  getEngines(): SearchEngineTemplate[] {
    return this.engines
  }

  getActiveEngine(): SearchEngineTemplate {
    return this.activeEngine
  }

  setActiveEngine(engineName: string): boolean {
    const engine = this.engines.find((e) => e.name === engineName)
    if (engine) {
      this.activeEngine = engine
      return true
    }
    return false
  }

  updateEngines(newEngines: SearchEngineTemplate[]): void {
    this.engines = newEngines
    if (!this.engines.find((e) => e.name === this.activeEngine.name)) {
      this.activeEngine = this.engines[0]
    }
  }

  private async initSearchWindow(conversationId: string): Promise<BrowserWindow> {
    if (this.searchWindows.size >= this.maxConcurrentSearches) {
      // 找到最早创建的窗口并销毁
      const [oldestConversationId] = this.searchWindows.keys()
      this.destroySearchWindow(oldestConversationId)
    }
    const mainWindow = presenter.windowPresenter.getWindow(MAIN_WIN)

    // 确保mainWindow存在
    if (!mainWindow) {
      console.error('主窗口不存在，无法创建搜索窗口')
      throw new Error('主窗口不存在')
    }

    // 检查是否处于全屏状态
    const isFullScreen = mainWindow.isFullScreen()
    this.wasFullScreen.set(conversationId, isFullScreen)

    // 如果是全屏，先退出全屏
    if (isFullScreen) {
      // 保存全屏前的位置和大小（如果可能的话）
      this.originalWindowSizes.set(conversationId, {
        width: mainWindow.getBounds().width,
        height: mainWindow.getBounds().height
      })
      this.originalWindowPositions.set(conversationId, {
        x: mainWindow.getBounds().x,
        y: mainWindow.getBounds().y
      })

      // 退出全屏并等待完成
      mainWindow.setFullScreen(false)

      // 等待退出全屏完成
      await new Promise<void>((resolve) => {
        const checkFullScreenState = () => {
          if (!mainWindow.isFullScreen()) {
            resolve()
          } else {
            setTimeout(checkFullScreenState, 100)
          }
        }
        checkFullScreenState()
      })

      // 给界面一些时间来重新布局
      await new Promise((resolve) => setTimeout(resolve, 200))
    } else {
      // 不是全屏模式，正常保存当前主窗口位置和大小信息
      this.originalWindowPositions.set(conversationId, {
        x: mainWindow.getBounds().x,
        y: mainWindow.getBounds().y
      })
      this.originalWindowSizes.set(conversationId, {
        width: mainWindow.getBounds().width,
        height: mainWindow.getBounds().height
      })
    }

    // 获取当前屏幕可用空间
    const mainWindowBounds = mainWindow.getBounds()
    const displayBounds = screen.getDisplayMatching(mainWindowBounds).workArea

    // 检查是否右侧有足够空间
    const rightSpace =
      displayBounds.x + displayBounds.width - (mainWindowBounds.x + mainWindowBounds.width)
    const needsAdjustment = rightSpace < this.searchWindowWidth + 20 // 加20px作为间隔

    // 如果需要调整窗口
    if (needsAdjustment) {
      // 在全屏模式下退出全屏后，优先采用两个窗口铺满屏幕的方式
      if (isFullScreen) {
        const totalWidth = displayBounds.width
        const mainWindowWidth = Math.floor(totalWidth * 0.6) // 主窗口占60%
        const searchWindowWidth = Math.floor(totalWidth * 0.4) // 搜索窗口占40%
        this.searchWindowWidth = searchWindowWidth

        // 设置主窗口尺寸和位置（使用Electron内置动画）
        mainWindow.setBounds(
          {
            x: displayBounds.x,
            y: displayBounds.y,
            width: mainWindowWidth,
            height: displayBounds.height
          },
          true
        ) // 添加true启用动画
      } else {
        // 非全屏模式下的调整逻辑
        // 计算左移窗口所需的空间
        const neededSpace = this.searchWindowWidth + 20 - rightSpace

        // 检查左侧是否有足够空间移动窗口
        const availableLeftSpace = mainWindowBounds.x - displayBounds.x

        // 优先移动窗口位置
        if (availableLeftSpace >= neededSpace) {
          // 有足够空间移动窗口位置
          const newX = Math.max(displayBounds.x, mainWindowBounds.x - neededSpace)
          // 使用Electron内置动画
          mainWindow.setPosition(newX, mainWindowBounds.y, true) // 添加true启用动画
        } else {
          // 左侧空间不足，结合移动和缩放
          // 先尽可能地移动窗口
          if (availableLeftSpace > 0) {
            mainWindow.setPosition(displayBounds.x, mainWindowBounds.y, true) // 添加true启用动画
          }

          // 计算需要缩放的大小
          const remainingNeededSpace = neededSpace - availableLeftSpace
          if (remainingNeededSpace > 0) {
            // 还需要缩放窗口
            const newWidth = Math.max(
              400, // 最小主窗口宽度
              mainWindowBounds.width - remainingNeededSpace
            )
            // 使用Electron内置动画
            mainWindow.setSize(newWidth, mainWindowBounds.height, true) // 添加true启用动画
          }
        }
      }

      // 给窗口一些时间来完成动画
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    console.log('creating search window')
    // 创建搜索窗口
    const searchWindow = new BrowserWindow({
      width: this.searchWindowWidth,
      height: isFullScreen ? displayBounds.height : mainWindowBounds.height,
      parent: mainWindow,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        devTools: is.dev
      }
    })

    // 获取调整后的主窗口位置
    const updatedMainBounds = mainWindow.getBounds()

    // 设置搜索窗口位置在主窗口右侧
    searchWindow.setPosition(updatedMainBounds.x + updatedMainBounds.width, updatedMainBounds.y)

    searchWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['*://*/*'] },
      (details, callback) => {
        const headers = {
          ...details.requestHeaders,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        callback({ requestHeaders: headers })
      }
    )
    if (is.dev) {
      searchWindow.webContents.openDevTools()
    }
    this.searchWindows.set(conversationId, searchWindow)
    return searchWindow
  }

  private async destroySearchWindow(conversationId: string) {
    const window = this.searchWindows.get(conversationId)
    if (window) {
      window.destroy()
      this.searchWindows.delete(conversationId)

      // 恢复主窗口原始位置和大小
      const originalSize = this.originalWindowSizes.get(conversationId)
      const originalPosition = this.originalWindowPositions.get(conversationId)
      const wasFullScreen = this.wasFullScreen.get(conversationId)

      if (originalSize && originalPosition) {
        const mainWindow = presenter.windowPresenter.getWindow(MAIN_WIN)
        if (mainWindow) {
          if (wasFullScreen) {
            // 如果原来是全屏，先恢复原始尺寸和位置，再进入全屏
            mainWindow.setBounds(
              {
                x: originalPosition.x,
                y: originalPosition.y,
                width: originalSize.width,
                height: originalSize.height
              },
              true
            ) // 添加true启用动画

            // 给UI一些时间来适应新尺寸
            await new Promise((resolve) => setTimeout(resolve, 300))

            // 重新进入全屏
            mainWindow.setFullScreen(true)
          } else {
            // 非全屏模式下平滑恢复
            mainWindow.setBounds(
              {
                x: originalPosition.x,
                y: originalPosition.y,
                width: originalSize.width,
                height: originalSize.height
              },
              true
            ) // 添加true启用动画
          }
        }

        this.originalWindowSizes.delete(conversationId)
        this.originalWindowPositions.delete(conversationId)
        this.wasFullScreen.delete(conversationId)
      }
    }
  }

  async search(conversationId: string, query: string): Promise<SearchResult[]> {
    // 创建用于可能中断搜索的 AbortController
    const abortController = new AbortController()
    this.abortControllers.set(conversationId, abortController)

    let searchWindow = this.searchWindows.get(conversationId)
    if (!searchWindow) {
      searchWindow = await this.initSearchWindow(conversationId)
    }

    const searchUrl = this.activeEngine.searchUrl.replace('{query}', encodeURIComponent(query))
    console.log('开始加载搜索URL:', searchUrl)

    const loadTimeout = setTimeout(() => {
      searchWindow?.webContents.stop()
    }, 8000)

    try {
      // 检查是否已经被中止
      if (abortController.signal.aborted) {
        throw new Error('搜索已被用户取消')
      }

      await searchWindow.loadURL(searchUrl)
      console.log('搜索URL加载成功')
    } catch (error) {
      console.error('加载URL失败:', error)
      if (abortController.signal.aborted) {
        // 如果是用户取消导致的错误，直接返回空结果
        this.destroySearchWindow(conversationId)
        this.abortControllers.delete(conversationId)
        return []
      }
    } finally {
      clearTimeout(loadTimeout)
    }

    // 检查是否已经被中止
    if (abortController.signal.aborted) {
      this.destroySearchWindow(conversationId)
      this.abortControllers.delete(conversationId)
      return []
    }

    await this.waitForSelector(searchWindow, this.activeEngine.selector)
    console.log('搜索结果加载完成')

    // 检查是否已经被中止
    if (abortController.signal.aborted) {
      this.destroySearchWindow(conversationId)
      this.abortControllers.delete(conversationId)
      return []
    }

    const results = await this.extractSearchResults(searchWindow)
    console.log('搜索结果提取完成:', results?.length)

    // 检查是否已经被中止
    if (abortController.signal.aborted) {
      this.destroySearchWindow(conversationId)
      this.abortControllers.delete(conversationId)
      return []
    }

    const enrichedResults = await this.enrichResults(results.slice(0, 5))
    console.log('详细内容获取完成')

    // 清理资源
    this.abortControllers.delete(conversationId)

    searchWindow
      .loadFile(helperPage)
      .then(() => {
        this.destroySearchWindow(conversationId)
      })
      .catch((error) => {
        console.error('加载空白页失败:', error)
        this.destroySearchWindow(conversationId)
      })
    const remainingResults = results.slice(5) // 获取剩余的结果
    const combinedResults = [...enrichedResults, ...remainingResults] // 合并enrichedResults和剩余的results
    return combinedResults
  }

  private async waitForSelector(window: BrowserWindow, selector: string): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve() // 12秒后自动返回
      }, 12000)
      // 如果selector不为空，就等待selector出现
      if (selector) {
        window.webContents
          .executeJavaScript(
            `
        new Promise((innerResolve) => {
          if (document.querySelector('${selector}')) {
            innerResolve();
          } else {
            const observer = new MutationObserver(() => {
              if (document.querySelector('${selector}')) {
                observer.disconnect();
                innerResolve();
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
          }
        })
      `
          )
          .then(() => {
            resolve()
          })
          .catch(() => {
            resolve()
          })

        clearTimeout(timeout)
        resolve()
      }
    })
  }

  private async extractSearchResults(window: BrowserWindow): Promise<SearchResult[]> {
    return await window.webContents.executeJavaScript(`
      (function() {
        ${this.activeEngine.extractorScript}
      })()
    `)
  }

  private async enrichResults(results: SearchResult[]): Promise<SearchResult[]> {
    return await ContentEnricher.enrichResults(results)
  }

  /**
   * 停止特定会话的搜索操作
   * @param conversationId 会话ID
   */
  async stopSearch(conversationId: string): Promise<void> {
    console.log('停止搜索, conversationId:', conversationId)

    // 中止搜索操作
    const abortController = this.abortControllers.get(conversationId)
    if (abortController) {
      abortController.abort()
      this.abortControllers.delete(conversationId)
    }

    // 关闭搜索窗口
    await this.destroySearchWindow(conversationId)
  }

  destroy() {
    // 中止所有搜索操作
    for (const controller of this.abortControllers.values()) {
      controller.abort()
    }
    this.abortControllers.clear()

    for (const [conversationId] of this.searchWindows) {
      this.destroySearchWindow(conversationId)
    }
    this.originalWindowSizes.clear()
    this.originalWindowPositions.clear()
    this.wasFullScreen.clear()
  }
}
