# DeepChat E2E 测试方案（修订版）

## 执行摘要

经过对主流 Electron E2E 测试方案的调研，**推荐使用 Playwright for Electron** 作为 DeepChat 项目的 E2E 测试框架。

**核心理由：**
- ✅ Electron 官方推荐（Spectron 已废弃）
- ✅ 完整的 TypeScript 支持
- ✅ 支持桌面 GUI 环境运行（Linux/Mac/Windows）
- ✅ 与现有 Vitest 配置完全独立
- ✅ 活跃的社区维护和完善的文档
- ✅ 可集成到 DevClaw 自动化流程

---

## 新约束条件

根据用户反馈，本方案遵循以下原则：

1. **单元测试和 E2E 测试分离** - 各自独立配置，不混为一谈
2. **不需要 headless 支持** - E2E 测试只在有 GUI 的桌面系统上运行
3. **测试代码独立目录** - E2E 测试放在项目根目录的 `tests/e2e`，不混合在 src 或 test 中

---

## 1. 技术选型对比

### 1.1 方案对比表

| 方案 | 状态 | Electron 支持 | GUI 环境 | TypeScript | 学习曲线 | 推荐度 |
|------|------|--------------|----------|------------|----------|--------|
| **Playwright** | ✅ 活跃 | ✅ 实验性支持 | ✅ | ✅ | 低 | ⭐⭐⭐⭐⭐ |
| Spectron | ❌ 已废弃 | ✅ | ✅ | ✅ | 中 | ❌ 不推荐 |
| Cypress + Electron | ✅ 活跃 | ⚠️ 有限 | ✅ | ✅ | 中 | ⭐⭐⭐ |
| Puppeteer | ✅ 活跃 | ⚠️ 需要配置 | ✅ | ✅ | 中 | ⭐⭐ |
| Vitest (组件) | ✅ 活跃 | ❌ 仅组件 | N/A | ✅ | 低 | ⭐⭐⭐⭐ (单元测试) |
| WebDriverIO | ✅ 活跃 | ✅ | ✅ | ✅ | 高 | ⭐⭐⭐ |

### 1.2 各方案详细分析

#### Playwright for Electron ⭐ 推荐

**优点：**
- Electron 官方文档推荐的 Spectron 替代方案
- 通过 Chrome DevTools Protocol (CDP) 直接控制 Electron
- 支持访问 Electron 主进程和渲染进程
- 完整的自动等待机制，减少 flaky tests
- 内置测试运行器 (`@playwright/test`)
- 支持多浏览器上下文隔离
- 优秀的 Trace Viewer 调试工具
- 支持 API 测试 + E2E 测试统一框架
- **无需 headless 配置，直接在桌面环境运行**

**缺点：**
- Electron 支持标记为"实验性"（但已稳定使用多年）
- 需要额外的 electron-playwright-helpers 处理菜单等原生功能

**适用场景：** 完整的 E2E 测试，包括主进程和渲染进程交互

---

#### Spectron ❌ 不推荐

**状态：** 2021 年 12 月官方宣布废弃，不再维护

**问题：**
- 基于 WebdriverIO，依赖 ChromeDriver
- 不再支持新版 Electron
- 社区已迁移到 Playwright/WebDriverIO
- 无 TypeScript 现代支持

**替代方案：** Playwright 或 WebDriverIO

---

#### Cypress + Electron ⚠️ 有限推荐

**优点：**
- 优秀的开发者体验和时间旅行调试
- 自动等待和重试机制
- 丰富的插件生态

**缺点：**
- 对 Electron 支持有限，主要面向 Web
- 需要 cypress-electron 插件
- 无法直接访问 Electron 主进程 API
- 多浏览器支持不如 Playwright

**适用场景：** 仅测试渲染进程 UI，不需要主进程交互

---

#### Puppeteer ⚠️ 备选

**优点：**
- 轻量级，专注于 Chromium 控制
- 可通过 CDP 控制 Electron

**缺点：**
- 需要手动配置 Electron 启动
- 社区支持不如 Playwright
- 功能相对单一

**适用场景：** 简单的渲染进程测试

---

#### Vitest (组件测试) ⭐ 推荐用于单元测试

**优点：**
- 项目已集成，配置完善
- 极速测试执行（Vite 原生支持）
- 与 Vue 3 深度集成
- 支持 jsdom 环境

**缺点：**
- 仅适合组件/单元测试，不是真正的 E2E
- 无法测试完整的 Electron 应用行为

**适用场景：** renderer 组件单元测试、工具函数测试

---

## 2. 推荐技术栈

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    DeepChat 测试金字塔                    │
├─────────────────────────────────────────────────────────┤
│                      E2E 测试 (5-10%)                    │
│              Playwright for Electron                     │
│          测试关键用户流程和跨进程交互                      │
│          目录：tests/e2e/                                │
├─────────────────────────────────────────────────────────┤
│                   集成测试 (20-30%)                      │
│              Vitest + @vue/test-utils                    │
│          测试组件交互、store、composables                │
│          目录：src/**/*.test.ts                          │
├─────────────────────────────────────────────────────────┤
│                   单元测试 (60-70%)                      │
│              Vitest (现有配置)                           │
│          工具函数、纯函数、简单组件                       │
│          目录：src/**/*.test.ts                          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 依赖包

```json
{
  "devDependencies": {
    "@playwright/test": "^1.50.0",
    "electron-playwright-helpers": "^2.1.0"
  }
}
```

**注意：** 不再需要 `xvfb-maybe`，因为 E2E 测试只在有 GUI 的桌面环境运行。

### 2.3 选择理由

1. **与现有工具链兼容**：项目已使用 TypeScript、Vite、Vitest，Playwright 无缝集成
2. **DevClaw 集成友好**：支持 CLI 运行、JUnit 报告、CI/CD 集成
3. **桌面环境友好**：直接在 Linux/Mac/Windows 桌面运行，无需 headless 配置
4. **测试速度快**：并行执行，典型 E2E 套件 < 5 分钟
5. **调试体验优秀**：Trace Viewer、Playwright Inspector
6. **配置独立**：与 Vitest 完全分离，互不干扰

---

## 3. 目录结构

### 3.1 项目结构

```
deepchat/
├── src/                          # 源代码
│   ├── main/                     # 主进程代码
│   ├── renderer/                 # 渲染进程代码
│   └── shared/                   # 共享代码
├── tests/                        # 测试代码（独立目录）
│   ├── e2e/                      # E2E 测试（Playwright）
│   │   ├── fixtures/
│   │   │   └── electron.fixture.ts
│   │   ├── specs/
│   │   │   ├── app-launch.spec.ts        # 应用启动测试
│   │   │   ├── chat-flow.spec.ts         # 聊天流程测试
│   │   │   ├── settings.spec.ts          # 设置页面测试
│   │   │   └── thread-management.spec.ts # 会话管理测试
│   │   └── utils/
│   │       └── test-helpers.ts
│   └── unit/                     # 单元测试（可选，主要用 src 内的 *.test.ts）
├── package.json
├── playwright.config.ts          # Playwright 独立配置
├── vitest.config.ts              # Vitest 主配置（单元测试）
└── vitest.config.renderer.ts     # Vitest 渲染配置（组件测试）
```

### 3.2 配置分离说明

| 配置类型 | 配置文件 | 测试框架 | 测试目录 | 运行命令 |
|---------|---------|---------|---------|---------|
| 单元测试 | `vitest.config.ts` | Vitest | `src/**/*.test.ts` | `pnpm test:unit` |
| 组件测试 | `vitest.config.renderer.ts` | Vitest | `src/**/*.test.ts` | `pnpm test:unit` |
| E2E 测试 | `playwright.config.ts` | Playwright | `tests/e2e/**/*.spec.ts` | `pnpm test:e2e` |

---

## 4. 配置文件

### 4.1 package.json scripts

```json
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest",
    "test:unit:ui": "vitest --ui",
    "test:unit:coverage": "vitest --coverage",
    "test:e2e": "playwright test",
    "test:e2e:debug": "playwright test --debug",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:report": "playwright show-report",
    "test:all": "pnpm run test:unit && pnpm run test:e2e"
  }
}
```

**说明：**
- `test:unit` - 运行所有单元测试（包括组件测试）
- `test:e2e` - 运行 E2E 测试
- `test:all` - 按顺序运行所有测试
- 两者完全独立，可单独运行

### 4.2 playwright.config.ts

```typescript
import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'path'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/e2e-results.xml' }],
    ['list']
  ],
  timeout: 30 * 1000,
  expect: {
    timeout: 5000
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
        ...devices['Desktop Chrome']
      }
    }
  ],
  outputDir: 'test-results/',
  webServer: {
    command: 'pnpm run dev',
    port: 5173,
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI
  }
})
```

**关键变化：**
- `testDir` 指向 `./tests/e2e`（独立目录）
- 移除 Xvfb 相关配置
- 保持简单的桌面环境运行配置

### 4.3 tests/e2e/fixtures/electron.fixture.ts

```typescript
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
```

### 4.4 vitest.config.ts（单元测试配置，保持不变）

```typescript
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.e2e.test.ts', 'tests/e2e/**/*'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,vue}'],
      exclude: ['src/**/*.test.ts', 'src/**/*.e2e.test.ts']
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
})
```

**关键变化：**
- `exclude` 明确排除 E2E 测试目录
- 确保单元测试和 E2E 测试不会相互干扰

---

## 5. 示例测试代码

### 5.1 应用启动测试

```typescript
// tests/e2e/specs/app-launch.spec.ts
import { test, expect } from '../fixtures/electron.fixture'

test.describe('Application Launch', () => {
  test('should launch successfully and show main window', async ({ page }) => {
    // 验证窗口标题
    await expect(page).toHaveTitle(/DeepChat/)
    
    // 验证主界面元素加载
    await expect(page.locator('[data-testid="chat-container"]')).toBeVisible()
  })

  test('should load without errors', async ({ electronApp }) => {
    // 检查主进程是否有错误
    const consoleLogs: string[] = []
    electronApp.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleLogs.push(msg.text())
      }
    })

    // 等待应用稳定
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    expect(consoleLogs).toHaveLength(0)
  })
})
```

### 5.2 聊天流程测试

```typescript
// tests/e2e/specs/chat-flow.spec.ts
import { test, expect } from '../fixtures/electron.fixture'

test.describe('Chat Flow', () => {
  test.beforeEach(async ({ page }) => {
    // 等待聊天界面就绪
    await page.waitForSelector('[data-testid="chat-input"]')
  })

  test('should send a message and receive response', async ({ page }) => {
    const testMessage = 'Hello, this is a test message'
    
    // 输入消息
    await page.locator('[data-testid="chat-input"]').fill(testMessage)
    
    // 发送消息
    await page.locator('[data-testid="send-button"]').click()
    
    // 验证消息出现在聊天历史中
    const messageElement = page.locator(`[data-testid="message"]:has-text("${testMessage}")`)
    await expect(messageElement).toBeVisible()
    
    // 等待响应（根据实际 API 调整超时）
    await page.waitForSelector('[data-testid="message"]:nth-child(2)', { timeout: 10000 })
  })

  test('should handle new chat', async ({ page }) => {
    // 点击新建聊天按钮
    await page.locator('[data-testid="new-chat-button"]').click()
    
    // 验证聊天历史清空
    await expect(page.locator('[data-testid="message"]')).toHaveCount(0)
    
    // 验证输入框清空
    await expect(page.locator('[data-testid="chat-input"]')).toHaveValue('')
  })
})
```

### 5.3 设置页面测试

```typescript
// tests/e2e/specs/settings.spec.ts
import { test, expect } from '../fixtures/electron.fixture'

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    // 导航到设置页面
    await page.locator('[data-testid="settings-button"]').click()
    await page.waitForSelector('[data-testid="settings-container"]')
  })

  test('should change theme setting', async ({ page }) => {
    // 找到主题选择器
    const themeSelector = page.locator('[data-testid="theme-selector"]')
    
    // 切换到暗色主题
    await themeSelector.selectOption('dark')
    
    // 验证主题应用
    const body = page.locator('body')
    await expect(body).toHaveClass(/dark/)
  })

  test('should save and load API key', async ({ page }) => {
    const testApiKey = 'sk-test123456789'
    
    // 输入 API Key
    await page.locator('[data-testid="api-key-input"]').fill(testApiKey)
    
    // 保存设置
    await page.locator('[data-testid="save-settings-button"]').click()
    
    // 验证保存成功提示
    await expect(page.locator('[data-testid="toast-success"]')).toBeVisible()
    
    // 重新打开设置验证
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="api-key-input"]')).toHaveValue(testApiKey)
  })
})
```

---

## 6. 实施步骤清单

### 阶段 1：基础设置（优先级：高）

- [ ] **安装依赖**
  ```bash
  pnpm add -D @playwright/test electron-playwright-helpers
  ```

- [ ] **创建独立测试目录**
  ```bash
  mkdir -p tests/e2e/fixtures
  mkdir -p tests/e2e/specs
  mkdir -p tests/e2e/utils
  ```

- [ ] **创建 Playwright 配置**
  - 创建 `playwright.config.ts`（根目录）
  - 创建 `tests/e2e/fixtures/electron.fixture.ts`

- [ ] **更新 package.json scripts**
  - 添加 `test:unit`、`test:e2e`、`test:all` 等命令

- [ ] **创建示例测试**
  - 创建 `tests/e2e/specs/app-launch.spec.ts`

- [ ] **验证基础配置**
  ```bash
  pnpm run test:e2e
  ```

### 阶段 2：核心流程测试（优先级：高）

- [ ] **实现聊天流程测试**
  - `tests/e2e/specs/chat-flow.spec.ts`
  - 覆盖发送消息、接收响应、新建聊天

- [ ] **实现设置页面测试**
  - `tests/e2e/specs/settings.spec.ts`
  - 覆盖主题切换、API Key 配置

- [ ] **实现会话管理测试**
  - `tests/e2e/specs/thread-management.spec.ts`
  - 覆盖会话创建、切换、删除

### 阶段 3：CI/CD 集成（优先级：中）

- [ ] **配置 GitHub Actions**
  - 创建 `.github/workflows/e2e-test.yml`
  - 配置桌面环境依赖（无需 Xvfb）

- [ ] **配置测试报告**
  - 集成 JUnit 报告
  - 配置 HTML 报告上传

- [ ] **集成 DevClaw**
  - 将 E2E 测试纳入工作流
  - 配置测试失败时的通知

### 阶段 4：优化和扩展（优先级：低）

- [ ] **性能优化**
  - 并行执行测试
  - 优化测试启动时间

- [ ] **增加测试覆盖率**
  - 添加更多边界情况测试
  - 添加错误处理测试

- [ ] **文档完善**
  - 编写测试开发指南
  - 添加测试最佳实践文档

---

## 7. CI/CD 集成建议

### 7.1 GitHub Actions 配置（简化版）

```yaml
# .github/workflows/e2e-test.yml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Install Playwright browsers
        run: pnpm exec playwright install --with-deps
      
      - name: Build application
        run: pnpm run build
      
      - name: Run E2E tests
        run: pnpm run test:e2e
        env:
          CI: 'true'
      
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
      
      - name: Upload test results JUnit
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: test-results/e2e-results.xml
          retention-days: 7
```

**关键变化：**
- **移除 Xvfb 配置** - GitHub Actions 的 ubuntu-latest 已支持 GUI 环境
- **简化依赖安装** - `playwright install --with-deps` 自动处理系统依赖
- **保留 CI 环境变量** - 用于控制重试和 worker 数量

### 7.2 本地开发环境

**Linux (Ubuntu/Debian):**
```bash
# 安装系统依赖（首次）
sudo apt-get update
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2 libpango-1.0-0 libcairo2

# 安装 Playwright 浏览器
pnpm exec playwright install
```

**macOS:**
```bash
# 无需额外系统依赖
pnpm exec playwright install
```

**Windows:**
```bash
# 无需额外系统依赖
pnpm exec playwright install
```

### 7.3 DevClaw 集成

在 DevClaw 工作流中，E2E 测试应作为 Tester 角色的验证步骤：

1. **Developer 完成代码后** → PR 创建
2. **Reviewer 批准后** → 自动触发 E2E 测试
3. **E2E 测试通过** → 合并到 main
4. **E2E 测试失败** → 返回 To Improve 状态

### 7.4 测试运行时间优化

为确保测试运行时间 < 10 分钟：

- ✅ 并行执行测试（`fullyParallel: true`）
- ✅ 使用测试隔离，避免相互依赖
- ✅ 复用 Electron 实例（通过 fixture）
- ✅ 合理设置超时（避免过长等待）
- ✅ CI 环境限制 worker 数量避免资源竞争

预期时间：
- 单元测试：~30 秒
- 组件测试：~1 分钟
- E2E 测试：~3-5 分钟（5-10 个测试用例）
- **总计：~5-7 分钟** ✅

---

## 8. 约束条件验证

| 约束 | 要求 | Playwright 方案 | 状态 |
|------|------|----------------|------|
| 测试分离 | 单元/E2E 独立配置 | ✅ 完全独立 | ✅ 满足 |
| 无需 headless | 桌面 GUI 环境运行 | ✅ 直接运行 | ✅ 满足 |
| 独立目录 | `tests/e2e` 文件夹 | ✅ 独立目录 | ✅ 满足 |
| Linux 环境 | 必须支持 | ✅ 原生支持 | ✅ 满足 |
| 运行时间 | < 10 分钟 | ✅ 预计 5-7 分钟 | ✅ 满足 |
| DevClaw 集成 | 必须支持 | ✅ CLI + JUnit 报告 | ✅ 满足 |

---

## 9. 风险与缓解

### 风险 1：Electron 支持标记为"实验性"

**缓解措施：**
- Playwright 的 Electron 支持已稳定使用多年
- 大量生产项目在使用（包括 VS Code 扩展测试）
- 定期更新 Playwright 版本获取最新修复

### 风险 2：测试 flaky（不稳定）

**缓解措施：**
- 使用 Playwright 的自动等待机制
- 避免硬编码等待时间
- 使用 data-testid 选择器
- CI 环境配置重试（retries: 2）

### 风险 3：测试运行时间长

**缓解措施：**
- 并行执行测试
- 优化测试用例数量（聚焦关键流程）
- 使用测试隔离避免相互影响
- 定期审查和清理慢测试

### 风险 4：CI 环境 GUI 支持

**缓解措施：**
- GitHub Actions ubuntu-latest 已支持 GUI
- 使用 `playwright install --with-deps` 自动安装依赖
- 如遇问题，可切换到 `ubuntu-22.04` 或更新版本

---

## 10. 后续建议

1. **逐步迁移**：先添加新功能的 E2E 测试，逐步覆盖核心流程
2. **测试文档**：编写团队内部的 E2E 测试开发指南
3. **定期审查**：每季度审查测试套件，移除冗余测试
4. **监控指标**：跟踪测试执行时间、通过率、flaky 测试数量
5. **保持独立**：始终维护单元测试和 E2E 测试的清晰边界

---

## 附录 A：快速开始命令

```bash
# 1. 安装依赖
pnpm add -D @playwright/test electron-playwright-helpers

# 2. 创建测试目录
mkdir -p tests/e2e/fixtures tests/e2e/specs

# 3. 初始化 Playwright 配置（手动创建 playwright.config.ts）

# 4. 安装浏览器
pnpm exec playwright install

# 5. 运行单元测试
pnpm run test:unit

# 6. 运行 E2E 测试
pnpm run test:e2e

# 7. 调试模式
pnpm run test:e2e:debug

# 8. 带 UI 运行
pnpm run test:e2e:ui

# 9. 查看测试报告
pnpm run test:e2e:report

# 10. 运行所有测试
pnpm run test:all
```

---

## 附录 B：有用资源

- [Playwright Electron 文档](https://playwright.dev/docs/api/class-electron)
- [electron-playwright-helpers](https://www.npmjs.com/package/electron-playwright-helpers)
- [Electron 自动化测试官方指南](https://www.electronjs.org/docs/latest/tutorial/automated-testing)
- [Playwright 最佳实践](https://playwright.dev/docs/best-practices)
- [electron-playwright-example](https://github.com/spaceagetv/electron-playwright-example)
- [Playwright CI 集成](https://playwright.dev/docs/ci-intro)

---

*文档版本：2.0 (修订版)*  
*创建日期：2026-03-02*  
*修订日期：2026-03-02*  
*适用项目：DeepChat v0.5.8*  
*主要变更：单元测试/E2E 分离、移除 headless 支持、测试代码独立目录*
