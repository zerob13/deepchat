import { test, expect } from '../fixtures/electron.fixture'

test.describe('DeepChat Basic Test', () => {
  test('should respond to directory listing prompt', async ({ page }) => {
    // 等待应用加载完成 - 查找聊天输入区域
    // 使用 TipTap 编辑器的特征选择器
    await page.waitForSelector('.ProseMirror, [contenteditable="true"], textarea', {
      timeout: 30000
    })

    // 查找输入框 - TipTap 编辑器通常使用 .ProseMirror 类
    let inputLocator = page.locator('.ProseMirror').first()

    // 如果找不到，尝试其他选择器
    if (!(await inputLocator.count())) {
      inputLocator = page.locator('[contenteditable="true"]').first()
    }

    // 输入测试提示词
    const testPrompt = '请看一下当前目录有什么文件，当前是什么目录'
    await inputLocator.fill(testPrompt)

    // 查找发送按钮 - 通常是一个包含发送图标的按钮
    // 尝试多种选择器
    let sendButton = page.locator('button:has-text("发送"), button:has-text("Send")').first()

    if (!(await sendButton.count())) {
      // 尝试查找带有发送图标的按钮（通常是 SVG 图标）
      sendButton = page.locator('button[aria-label*="send" i], button[title*="send" i]').first()
    }

    if (!(await sendButton.count())) {
      // 尝试查找最后一个按钮（通常是发送按钮）
      sendButton = page.locator('button').last()
    }

    await sendButton.click()

    // 等待响应（超时 2 分钟）
    const responseTimeout = 120000 // 2 分钟

    // 等待出现新的消息（除了用户输入的消息外）
    // 查找消息容器中的新内容
    await page.waitForFunction(
      () => {
        const messages = document.querySelectorAll(
          '[class*="message"], .message, [class*="chat-message"]'
        )
        return messages.length > 0
      },
      { timeout: responseTimeout }
    )

    // 获取响应内容
    const messageContainer = page
      .locator('[class*="message"], .message, [class*="chat-message"]')
      .first()
    const responseText = await messageContainer.textContent()

    // 验证有响应数据返回
    expect(responseText).toBeTruthy()
    expect(responseText?.length).toBeGreaterThan(0)

    console.log('响应内容:', responseText)
  })
})
