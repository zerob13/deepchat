import { test as base, _electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type ElectronFixture = {
  electronApp: ElectronApplication
  page: Page
}

export const test = base.extend<ElectronFixture>({
  electronApp: async ({}, use) => {
    const projectRoot = resolve(__dirname, '../../../')

    // 启动 Electron 应用（使用预构建的 out 目录）
    console.log('Launching Electron app...')
    const electronApp = await _electron.launch({
      args: [resolve(projectRoot, 'out/main/index.js')],
      cwd: projectRoot,
      env: {
        ...process.env,
        VITE_ENABLE_PLAYGROUND: 'true',
        DISPLAY: process.env.DISPLAY || ':0',
        ELECTRON_DISABLE_GPU: '1'
      }
    })

    console.log('Electron app launched, waiting for window...')

    // 等待主窗口创建并加载完成
    const page = await electronApp.waitForEvent('window', {
      predicate: (page) => {
        const url = page.url()
        // 排除 DevTools 窗口
        return !url.includes('devtools://') && !url.includes('chrome-extension://')
      },
      timeout: 120000 // 2 分钟超时
    })

    console.log('Window detected, URL:', page.url())

    // 等待页面完全加载
    await page.waitForLoadState('domcontentloaded')
    console.log('Page loaded, waiting for app to be ready...')

    // 等待应用完全就绪（等待聊天输入框出现）
    try {
      await page.waitForSelector('[data-testid="chat-input-editor"]', {
        state: 'visible',
        timeout: 60000
      })
      console.log('App is ready!')
    } catch (e) {
      console.log('Chat input not found, trying fallback selector...')
      // 回退到通用选择器
      await page.waitForSelector('.ProseMirror, [contenteditable="true"]', {
        state: 'visible',
        timeout: 30000
      })
    }

    await use(electronApp)

    // 清理
    await electronApp.close()
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await use(page)
  }
})

export { expect } from '@playwright/test'
