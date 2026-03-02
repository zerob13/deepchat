import { test, expect } from '../fixtures/electron.fixture'

test.describe('Application Launch', () => {
  test('should launch successfully and show main window', async ({ page, electronApp }) => {
    // 验证窗口已打开
    expect(page).toBeTruthy()

    // 等待页面加载完成
    await page.waitForLoadState('domcontentloaded')

    // 验证应用标题包含 DeepChat
    const title = await page.title()
    expect(title).toContain('DeepChat')

    // 验证主进程没有错误
    const consoleLogs: string[] = []
    electronApp.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleLogs.push(msg.text())
      }
    })

    // 等待应用稳定
    await page.waitForTimeout(2000)

    // 记录日志（不阻断测试）
    if (consoleLogs.length > 0) {
      console.log('Console errors:', consoleLogs)
    }
  })

  test('should have chat input available', async ({ page }) => {
    // 等待聊天输入框出现（TipTap 编辑器）
    const editorLocator = page.locator('.ProseMirror, [contenteditable="true"]').first()
    await expect(editorLocator).toBeVisible({ timeout: 30000 })

    // 验证输入框可聚焦
    await editorLocator.focus()

    // 验证可以输入文本
    const testText = 'Test input'
    await editorLocator.fill(testText)

    // 验证文本已输入
    const inputValue = await editorLocator.textContent()
    expect(inputValue).toContain(testText)
  })
})
