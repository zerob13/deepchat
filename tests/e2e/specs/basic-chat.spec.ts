import { test, expect } from '../fixtures/electron.fixture'

test.describe('DeepChat Basic Test', () => {
  test('should respond to directory listing prompt', async ({ page }) => {
    // 等待应用加载完成 - 使用 data-testid 选择器
    await page.waitForSelector('[data-testid="chat-input-editor"]', {
      timeout: 30000
    })

    // 查找输入框 - 使用 data-testid
    const inputLocator = page.locator('[data-testid="chat-input-editor"]')

    // 输入测试提示词
    const testPrompt = '请看一下当前目录有什么文件，当前是什么目录'
    await inputLocator.fill(testPrompt)

    // 查找发送按钮 - 使用 data-testid
    const sendButton = page.locator('[data-testid="chat-send-button"]')
    await sendButton.click()

    // 等待响应（超时 2 分钟）
    const responseTimeout = 120000 // 2 分钟

    // 等待消息列表中出现新消息
    await page.waitForSelector('[data-testid="message-list-container"]', {
      timeout: responseTimeout
    })

    // 获取响应内容 - 使用 data-testid 选择器
    const messageContainer = page.locator('[data-testid="message-bubble-assistant"]').first()
    const responseText = await messageContainer.textContent()

    // 验证有响应数据返回
    expect(responseText).toBeTruthy()
    expect(responseText?.length).toBeGreaterThan(0)

    console.log('响应内容:', responseText)
  })
})
