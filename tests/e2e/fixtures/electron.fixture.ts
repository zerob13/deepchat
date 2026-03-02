import { test as base, _electron, ElectronApplication, Page } from '@playwright/test'
import { resolve } from 'path'

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
        VITE_ENABLE_PLAYGROUND: 'true'
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
