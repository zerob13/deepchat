import { app, BrowserWindow } from 'electron'
import { eventBus } from '@/eventbus'
import path from 'path'
import { SearchResult, SearchEngineTemplate } from '@shared/chat'
import axios from 'axios'
import * as cheerio from 'cheerio'
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
  }
]

export class SearchManager {
  private searchWindows: Map<string, BrowserWindow> = new Map()
  private isDevelopment = process.env.NODE_ENV === 'development'
  private maxConcurrentSearches = 3
  private engines: SearchEngineTemplate[] = defaultEngines
  private activeEngine: SearchEngineTemplate = this.engines[0]

  constructor() {
    this.setupEventListeners()
  }

  private setupEventListeners() {
    eventBus.on('search-window-cleanup', (conversationId: string) => {
      this.destroySearchWindow(conversationId)
    })

    eventBus.on('search-engine-change', (engineName: string) => {
      const engine = this.engines.find((e) => e.name === engineName)
      if (engine) {
        this.activeEngine = engine
      }
    })
  }

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

  async search(conversationId: string, query: string): Promise<SearchResult[]> {
    let searchWindow = this.searchWindows.get(conversationId)
    if (!searchWindow) {
      searchWindow = this.initSearchWindow(conversationId)
    }

    const searchUrl = this.activeEngine.searchUrl.replace('{query}', encodeURIComponent(query))
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

    await this.waitForSelector(searchWindow, this.activeEngine.selector)
    console.log('搜索结果加载完成')

    const results = await this.extractSearchResults(searchWindow)
    console.log('搜索结果提取完成:', results?.length)

    const enrichedResults = await this.enrichResults(results.slice(0, 5))
    console.log('详细内容获取完成')

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
    const enrichedResults: SearchResult[] = []
    const timeout = 5000 // 5秒超时

    for (const result of results) {
      try {
        // 使用 axios 获取页面内容
        const response = await axios.get(result.url, {
          timeout,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        })

        const $ = cheerio.load(response.data)

        // 移除不需要的元素
        $('script, style, nav, header, footer, iframe, .ad, #ad, .advertisement').remove()

        // 尝试获取主要内容
        let mainContent = ''
        const possibleSelectors = [
          'article',
          'main',
          '.content',
          '#content',
          '.post-content',
          '.article-content',
          '.entry-content',
          '[role="main"]'
        ]

        for (const selector of possibleSelectors) {
          const element = $(selector)
          if (element.length > 0) {
            mainContent = element.text()
            break
          }
        }

        // 如果没有找到主要内容，使用 body
        if (!mainContent) {
          mainContent = $('body').text()
        }

        // 清理文本内容
        mainContent = mainContent
          .replace(/[\r\n]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000)
        let icon: string | undefined = result.icon
        if (!result.icon) {
          // 尝试获取网站图标
          icon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href')

          // 如果找到了相对路径的图标，转换为绝对路径
          if (icon && !icon.startsWith('http')) {
            const urlObj = new URL(result.url)
            icon = icon.startsWith('/')
              ? `${urlObj.protocol}//${urlObj.host}${icon}`
              : `${urlObj.protocol}//${urlObj.host}/${icon}`
          }

          // 如果没有找到图标，使用默认的 favicon.ico
          if (!icon) {
            const urlObj = new URL(result.url)
            icon = `${urlObj.protocol}//${urlObj.host}/favicon.ico`
          }
        }
        enrichedResults.push({
          ...result,
          content: mainContent || result.description || '',
          icon: icon || ''
        })
      } catch (error) {
        console.error(`Error fetching content for ${result.url}:`, error)
        // 如果获取失败，保留原始结果
        enrichedResults.push(result)
      }
    }

    return enrichedResults
  }

  destroy() {
    for (const [conversationId] of this.searchWindows) {
      this.destroySearchWindow(conversationId)
    }
  }
}
