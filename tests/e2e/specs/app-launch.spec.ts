import { test, expect } from '../fixtures/electron.fixture'

test.describe('Application Launch', () => {
  test('should launch successfully and show main window', async ({ page }) => {
    // 验证窗口已打开
    expect(page).toBeTruthy()

    // 验证应用标题包含 DeepChat
    const title = await page.title()
    console.log('Page title:', title)
    expect(title).toContain('DeepChat')

    // 验证聊天输入框可见（应用就绪标志）
    const chatInput = page.locator('[data-testid="chat-input-editor"]')
    await expect(chatInput).toBeVisible({ timeout: 60000 })
    console.log('Chat input is visible, app is ready!')
  })

  test('should have chat input available', async ({ page }) => {
    // 等待聊天输入框出现
    const editorLocator = page.locator('[data-testid="chat-input-editor"]')
    await expect(editorLocator).toBeVisible({ timeout: 60000 })

    // 验证输入框可聚焦
    await editorLocator.focus()
    console.log('Chat input focused')

    // 验证可以输入文本
    const testText = 'E2E Test Message'
    await editorLocator.fill(testText)
    console.log('Text filled:', testText)

    // 验证文本已输入
    const inputValue = await editorLocator.textContent()
    expect(inputValue).toContain(testText)
    console.log('Text verified in input')
  })
})
