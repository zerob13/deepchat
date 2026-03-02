# DeepChat E2E 测试指南

## 环境要求

### Linux 桌面环境

```bash
# 安装系统依赖（Ubuntu/Debian）
sudo apt-get update
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2 libpango-1.0-0 libcairo2
```

### 安装依赖

```bash
pnpm add -D @playwright/test electron-playwright-helpers
pnpm exec playwright install
```

### 运行测试

```bash
# 运行所有 E2E 测试
pnpm run test:e2e

# 调试模式运行
pnpm run test:e2e:debug

# 带 UI 运行
pnpm run test:e2e:ui

# 查看测试报告
pnpm run test:e2e:report

# 运行特定测试文件
pnpm run test:e2e tests/e2e/specs/app-launch.spec.ts

# 运行所有测试（单元 + E2E）
pnpm run test:all
```

## 目录结构

```
tests/e2e/
├── fixtures/
│   └── electron.fixture.ts      # Electron 测试夹具
├── specs/
│   ├── app-launch.spec.ts       # 应用启动测试
│   └── basic-chat.spec.ts       # 基础聊天测试
└── utils/
    └── test-helpers.ts          # 测试工具函数（可选）
```

## 编写测试

### 基本示例

```typescript
import { test, expect } from '../fixtures/electron.fixture'

test.describe('Feature Name', () => {
  test('should do something', async ({ page }) => {
    // 等待元素
    await page.waitForSelector('[data-testid="chat-input-editor"]')
    
    // 输入文本
    await page.locator('[data-testid="chat-input-editor"]').fill('Hello')
    
    // 点击按钮
    await page.locator('[data-testid="chat-send-button"]').click()
    
    // 验证结果
    await expect(page.locator('[data-testid="message-bubble-assistant"]')).toBeVisible()
  })
})
```

### 如何为组件添加测试选择器

在 Vue 组件中，为需要测试的 UI 元素添加 `data-testid` 属性：

```vue
<template>
  <!-- 输入框 -->
  <textarea data-testid="chat-input-editor" />
  
  <!-- 按钮 -->
  <button data-testid="chat-send-button">发送</button>
  
  <!-- 容器 -->
  <div data-testid="message-list-container">
    <!-- 消息气泡 -->
    <div data-testid="message-bubble-assistant">
      <div data-testid="message-content">内容</div>
    </div>
  </div>
</template>
```

#### 命名规范

- 使用 **kebab-case**（短横线分隔）
- 格式：`[组件]-[元素]-[用途]`
- 示例：
  - `chat-input-editor` - 聊天输入编辑器
  - `chat-send-button` - 发送按钮
  - `message-bubble-assistant` - 助手消息气泡
  - `message-list-container` - 消息列表容器

#### 最佳实践

1. **为关键交互元素添加** - 输入框、按钮、链接等
2. **为容器添加** - 便于定位和断言
3. **保持一致性** - 同一组件使用统一的命名风格
4. **避免过度使用** - 只为测试需要的元素添加

### 可用的 Fixtures

- `electronApp` - Electron 应用实例
- `page` - 主窗口页面

### 选择器建议

DeepChat 使用 `data-testid` 属性作为 E2E 测试的稳定选择器。推荐使用以下选择器：

- **输入框**: `[data-testid="chat-input-editor"]`
- **发送按钮**: `[data-testid="chat-send-button"]`
- **消息列表容器**: `[data-testid="message-list-container"]`
- **助手消息气泡**: `[data-testid="message-bubble-assistant"]`
- **用户消息气泡**: `[data-testid="message-bubble-user"]`

#### 为什么使用 data-testid？

1. **稳定性** - 不随 CSS 类名或布局变化而改变
2. **可读性** - 明确表达元素用途
3. **性能** - 比复杂的选择器查询更快
4. **维护性** - 测试代码更清晰，易于理解

## 配置说明

### playwright.config.ts

- `testDir`: `./tests/e2e` - 测试文件目录
- `timeout`: 30 秒 - 单个测试超时
- `expect.timeout`: 5 秒 - 断言超时
- `retries`: 0 次（本地测试）

### 与 Vitest 分离

E2E 测试与单元测试完全独立：

| 配置 | 文件 | 测试类型 | 运行命令 |
|------|------|----------|----------|
| Vitest | `vitest.config.ts` | 单元/组件 | `pnpm test:unit` |
| Playwright | `playwright.config.ts` | E2E | `pnpm test:e2e` |

## 调试技巧

1. **使用调试模式**: `pnpm run test:e2e:debug`
2. **使用 UI 模式**: `pnpm run test:e2e:ui`
3. **添加截图**: 
   ```typescript
   await page.screenshot({ path: 'screenshot.png' })
   ```
4. **查看 Trace**: 失败后运行 `pnpm run test:e2e:report`

## 最佳实践

1. **使用有意义的测试名称**
2. **避免硬编码等待** - 使用 `waitForSelector` 代替 `setTimeout`
3. **测试隔离** - 每个测试应该独立运行
4. **使用 Page Object 模式** - 复杂场景可创建页面对象
5. **合理设置超时** - E2E 测试通常较慢，设置合理的超时时间

## 常见问题

### Q: 测试运行失败，提示找不到 Electron
A: 确保已构建应用：`pnpm run build`

### Q: 测试运行失败，提示浏览器未安装
A: 运行 `pnpm exec playwright install` 安装浏览器

### Q: 如何选择特定的 UI 元素
A: 使用 Playwright Inspector: `pnpm run test:e2e:debug`

## 参考资源

- [Playwright 官方文档](https://playwright.dev)
- [Electron Playwright Helpers](https://www.npmjs.com/package/electron-playwright-helpers)
- [设计文档](../../docs/e2e-testing-proposal.md)
