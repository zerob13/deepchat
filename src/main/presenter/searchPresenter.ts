import { BrowserWindow } from 'electron'
import { eventBus } from '@/eventbus'

interface SearchResult {
  title: string
  url: string
  rank: number
  content?: string
}

export class SearchPresenter {
  private searchWindow: BrowserWindow | null = null
  private isDevelopment = process.env.NODE_ENV === 'development'

  constructor() {
    // 构造函数中不再初始化窗口
    this.setupEventListeners()
  }

  private setupEventListeners() {
    eventBus.on('search-requested', async (data: { messageId: string; query: string }) => {
      try {
        const results = await this.search(data.query)
        eventBus.emit('search-results', {
          messageId: data.messageId,
          results
        })
      } catch (error) {
        console.error('搜索失败:', error)
        eventBus.emit('search-results', {
          messageId: data.messageId,
          results: []
        })
      }
    })
  }

  init() {
    this.initSearchWindow()
  }

  private initSearchWindow() {
    if (this.searchWindow) {
      return
    }
    this.searchWindow = new BrowserWindow({
      width: 1024,
      height: 768,
      show: this.isDevelopment, // 开发模式下显示窗口
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })

    // 拦截请求，可以用来处理跨域等问题
    this.searchWindow.webContents.session.webRequest.onBeforeSendHeaders(
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
  }

  async search(query: string, engine: 'google' | 'baidu' = 'google'): Promise<SearchResult[]> {
    if (!this.searchWindow) {
      throw new Error('SearchPresenter not initialized')
    }

    const searchUrl = this.getSearchUrl(query, engine)
    console.log('开始加载搜索URL:', searchUrl)
    try {
      await this.searchWindow!.loadURL(searchUrl)
      console.log('搜索URL加载成功')
    } catch (error) {
      console.error('加载URL失败:', error)
    }

    // 等待搜索结果加载完成
    console.log('等待搜索结果加载完成...')
    await this.waitForSelector(engine === 'google' ? '#search' : '#content_left')
    console.log('搜索结果加载完成')

    // 提取搜索结果
    console.log('开始提取搜索结果...')
    const results = await this.extractSearchResults(engine)
    console.log('搜索结果提取完成:', results)

    // 获取详细内容
    console.log('开始获取详细内容...')
    const enrichedResults = await this.enrichResults(results)
    console.log('详细内容获取完成')

    return enrichedResults
  }

  private getSearchUrl(query: string, engine: 'google' | 'baidu'): string {
    const encodedQuery = encodeURIComponent(query)
    return engine === 'google'
      ? `https://www.google.com/search?q=${encodedQuery}`
      : `https://www.baidu.com/s?wd=${encodedQuery}`
  }

  private async waitForSelector(selector: string): Promise<void> {
    await this.searchWindow!.webContents.executeJavaScript(`
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

  private async extractSearchResults(engine: 'google' | 'baidu'): Promise<SearchResult[]> {
    return await this.searchWindow!.webContents.executeJavaScript(`
      (function() {
        const results = []
        if ('${engine}' === 'google') {
          const items = document.querySelectorAll('#search .g')
          items.forEach((item, index) => {
            const titleEl = item.querySelector('h3')
            const linkEl = item.querySelector('a')
            if (titleEl && linkEl) {
              results.push({
                title: titleEl.textContent,
                url: linkEl.href,
                rank: index + 1
              })
            }
          })
        } else {
          const items = document.querySelectorAll('#content_left .result')
          items.forEach((item, index) => {
            const titleEl = item.querySelector('.t')
            const linkEl = item.querySelector('a')
            if (titleEl && linkEl) {
              results.push({
                title: titleEl.textContent,
                url: linkEl.href,
                rank: index + 1
              })
            }
          })
        }
        return results.slice(0, 3) // 只返回前3个结果
      })()
    `)
  }

  private async enrichResults(results: SearchResult[]): Promise<SearchResult[]> {
    const enrichedResults: SearchResult[] = []

    for (const result of results) {
      try {
        await this.searchWindow!.loadURL(result.url)
        const content = await this.extractMainContent()
        enrichedResults.push({
          ...result,
          content
        })
      } catch (error) {
        console.error(`Error fetching content for ${result.url}:`, error)
      }
    }

    return enrichedResults
  }

  private async extractMainContent(): Promise<string> {
    return await this.searchWindow!.webContents.executeJavaScript(`
      (function() {
        // 移除不需要的元素
        const elementsToRemove = document.querySelectorAll('script, style, nav, header, footer, iframe, .ad, #ad, .advertisement')
        elementsToRemove.forEach(el => el.remove())

        // 尝试找到主要内容
        const mainContent =
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('.content') ||
          document.querySelector('#content') ||
          document.body

        return mainContent.textContent.trim().replace(/\\s+/g, ' ').slice(0, 3000) // 限制内容长度
      })()
    `)
  }

  destroy() {
    if (this.searchWindow) {
      this.searchWindow.destroy()
      this.searchWindow = null
    }
  }
}
