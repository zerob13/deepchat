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
    // 启动 Electron 应用
    const electronApp = await _electron.launch({
      args: [resolve(__dirname, '../../../')],
      env: {
        ...process.env,
        VITE_ENABLE_PLAYGROUND: 'true',
        // 支持无头模式（CI 环境）
        DISPLAY: process.env.DISPLAY || ':99'
      }
    })

    await use(electronApp)

    // 清理
    await electronApp.close()
  },
  page: async ({ electronApp }, use) => {
    // 等待第一个窗口打开
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  }
})

export { expect } from '@playwright/test'
