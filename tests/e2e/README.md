# DeepChat E2E 测试指南

## 快速开始

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
    await page.waitForSelector('.ProseMirror')
    
    // 输入文本
    await page.locator('.ProseMirror').fill('Hello')
    
    // 点击按钮
    await page.locator('button:has-text("发送")').click()
    
    // 验证结果
    await expect(page.locator('.message')).toBeVisible()
  })
})
```

### 可用的 Fixtures

- `electronApp` - Electron 应用实例
- `page` - 主窗口页面

### 选择器建议

由于 DeepChat 未使用 `data-testid`，建议使用以下选择器：

- **输入框**: `.ProseMirror`, `[contenteditable="true"]`
- **按钮**: `button:has-text("文本")`, `button[aria-label*="send"]`
- **消息**: `[class*="message"]`, `.message`

## 配置说明

### playwright.config.ts

- `testDir`: `./tests/e2e` - 测试文件目录
- `timeout`: 30 秒 - 单个测试超时
- `expect.timeout`: 5 秒 - 断言超时
- `retries`: CI 环境 2 次，本地 0 次

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

### Q: 测试在 CI 环境失败
A: 检查 GUI 环境依赖是否安装，或考虑使用 headless 模式

### Q: 如何选择特定的 UI 元素
A: 使用 Playwright Inspector: `pnpm run test:e2e:debug`

## 参考资源

- [Playwright 官方文档](https://playwright.dev)
- [Electron Playwright Helpers](https://www.npmjs.com/package/electron-playwright-helpers)
- [设计文档](../../docs/e2e-testing-proposal.md)
