import { app, BrowserWindow } from 'electron'
import { eventBus } from '@/eventbus'
import path from 'path'
import { SearchResult } from '@shared/presenter'
const helperPage = path.join(app.getAppPath(), 'resources', 'blankSearch.html')

export class SearchManager {
  private searchWindows: Map<string, BrowserWindow> = new Map()
  private isDevelopment = process.env.NODE_ENV === 'development'
  private maxConcurrentSearches = 3

  constructor() {
    this.setupEventListeners()
  }

  private setupEventListeners() {
    eventBus.on('search-window-cleanup', (conversationId: string) => {
      this.destroySearchWindow(conversationId)
    })
  }

  private initSearchWindow(conversationId: string): BrowserWindow {
    if (this.searchWindows.size >= this.maxConcurrentSearches) {
      // 找到最早创建的窗口并销毁
      const [oldestConversationId] = this.searchWindows.keys()
      this.destroySearchWindow(oldestConversationId)
    }

    const searchWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: this.isDevelopment,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })

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

    this.searchWindows.set(conversationId, searchWindow)
    return searchWindow
  }

  private destroySearchWindow(conversationId: string) {
    const window = this.searchWindows.get(conversationId)
    if (window) {
      window.destroy()
      this.searchWindows.delete(conversationId)
    }
  }

  async search(
    conversationId: string,
    query: string,
    engine: 'google' | 'baidu' = 'google'
  ): Promise<SearchResult[]> {
    let searchWindow = this.searchWindows.get(conversationId)
    if (!searchWindow) {
      searchWindow = this.initSearchWindow(conversationId)
    }

    const searchUrl = this.getSearchUrl(query, engine)
    console.log('开始加载搜索URL:', searchUrl)

    const loadTimeout = setTimeout(() => {
      searchWindow?.webContents.stop()
    }, 8000)

    try {
      await searchWindow.loadURL(searchUrl)
      console.log('搜索URL加载成功')
    } catch (error) {
      console.error('加载URL失败:', error)
    } finally {
      clearTimeout(loadTimeout)
    }

    await this.waitForSelector(searchWindow, engine === 'google' ? '#search' : '#content_left')
    console.log('搜索结果加载完成')

    const results = await this.extractSearchResults(searchWindow, engine)
    console.log('搜索结果提取完成:', results)

    const enrichedResults = await this.enrichResults(searchWindow, results.slice(0, 3))
    console.log('详细内容获取完成')

    searchWindow
      .loadFile(helperPage)
      .then(() => {
        console.log('空白页加载完成')
        this.destroySearchWindow(conversationId)
      })
      .catch((error) => {
        console.error('加载空白页失败:', error)
        this.destroySearchWindow(conversationId)
      })
    return [...enrichedResults, ...results.slice(3)]
  }

  private getSearchUrl(query: string, engine: 'google' | 'baidu'): string {
    const encodedQuery = encodeURIComponent(query)
    return engine === 'google'
      ? `https://www.google.com/search?q=${encodedQuery}`
      : `https://www.baidu.com/s?wd=${encodedQuery}`
  }

  private async waitForSelector(window: BrowserWindow, selector: string): Promise<void> {
    await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        if (document.querySelector('${selector}')) {
          resolve()
        } else {
          const observer = new MutationObserver(() => {
            if (document.querySelector('${selector}')) {
              observer.disconnect()
              resolve()
            }
          })
          observer.observe(document.body, { childList: true, subtree: true })
        }
      })
    `)
  }

  private async extractSearchResults(
    window: BrowserWindow,
    engine: 'google' | 'baidu'
  ): Promise<SearchResult[]> {
    return await window.webContents.executeJavaScript(`
      (function() {
        const results = []
        if ('${engine}' === 'google') {
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
        } else {
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
        }
        return results
      })()
    `)
  }

  private async enrichResults(
    window: BrowserWindow,
    results: SearchResult[]
  ): Promise<SearchResult[]> {
    const enrichedResults: SearchResult[] = []

    for (const result of results) {
      try {
        const loadTimeout = setTimeout(() => {
          window?.webContents.stop()
        }, 5000)

        try {
          await window.loadURL(result.url)
        } catch (error) {
          console.error(`加载页面失败 ${result.url}:`, error)
        } finally {
          clearTimeout(loadTimeout)
        }

        let content = await this.extractMainContent(window)
        if (!content) {
          content = result.description ?? ''
        }
        enrichedResults.push({
          ...result,
          content
        })

        await window.loadURL('about:blank')
      } catch (error) {
        console.error(`Error fetching content for ${result.url}:`, error)
        enrichedResults.push(result)
      }
    }

    return enrichedResults
  }

  private async extractMainContent(window: BrowserWindow): Promise<string> {
    const result = await window.webContents.executeJavaScript(`
      (function() {
        const elementsToRemove = document.querySelectorAll('script, style, nav, header, footer, iframe, .ad, #ad, .advertisement')
        elementsToRemove.forEach(el => el.remove())

        const mainContent =
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('.content') ||
          document.querySelector('#content') ||
          document.body

        let icon = document.querySelector('link[rel="icon"]')?.href ||
                  document.querySelector('link[rel="shortcut icon"]')?.href ||
                  new URL('/favicon.ico', window.location.origin).href

        return {
          content: mainContent.textContent.trim().replace(/\\s+/g, ' ').slice(0, 3000),
          icon
        }
      })()
    `)
    return result.content
  }

  destroy() {
    for (const [conversationId] of this.searchWindows) {
      this.destroySearchWindow(conversationId)
    }
  }
}
