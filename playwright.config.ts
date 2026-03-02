import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // 串行运行
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/e2e-results.xml' }],
    ['list']
  ],
  timeout: 180 * 1000, // 3 分钟总超时
  expect: {
    timeout: 60000 // 单个断言超时 60 秒
  },
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'electron',
      testMatch: '**/*.spec.ts',
      use: {
        launchOptions: {
          slowMo: 100 // 操作之间等待 100ms，让 UI 更稳定
        }
      }
    }
  ],
  outputDir: 'test-results/',
  // 预先启动 Electron 应用
  webServer: {
    command: 'pnpm run dev:linux',
    port: 5173, // Vite dev server 端口
    timeout: 120 * 1000,
    reuseExistingServer: true,
    // 等待应用完全启动
    readyWhen: /Window \d+ created successfully/
  }
})
