import { test, expect } from '../fixtures/electron.fixture'

test.describe('DeepChat Basic Test', () => {
  test('should respond to directory listing prompt', async ({ page }) => {
    console.log('=== Starting Basic Chat Test ===')

    // 等待应用加载完成
    console.log('Waiting for chat input...')
    await page.waitForSelector('[data-testid="chat-input-editor"]', {
      timeout: 60000,
      state: 'visible'
    })
    console.log('Chat input found')

    // 查找输入框
    const inputLocator = page.locator('[data-testid="chat-input-editor"]')

    // 输入测试提示词
    const testPrompt = '请看一下当前目录有什么文件，当前是什么目录'
    console.log('Filling prompt:', testPrompt)
    await inputLocator.fill(testPrompt)
    console.log('Prompt filled')

    // 查找发送按钮并点击
    const sendButton = page.locator('[data-testid="chat-send-button"]')
    console.log('Clicking send button...')
    await sendButton.click()
    console.log('Send button clicked')

    // 等待响应（超时 2 分钟）
    console.log('Waiting for response (up to 2 minutes)...')

    // 等待消息列表中出现助手消息
    const messageLocator = page.locator('[data-testid="message-bubble-assistant"]')
    await messageLocator.waitFor({
      state: 'visible',
      timeout: 120000 // 2 分钟
    })
    console.log('Assistant message detected')

    // 获取响应内容
    const responseText = await messageLocator.first().textContent()
    console.log('Response received, length:', responseText?.length)

    // 验证有响应数据返回
    expect(responseText).toBeTruthy()
    expect(responseText?.length).toBeGreaterThan(0)

    console.log('=== Test Completed Successfully ===')
  })
})
