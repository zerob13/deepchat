/**
 * E2E 测试工具函数
 */

import { Page } from '@playwright/test'

/**
 * 等待聊天界面就绪
 */
export async function waitForChatReady(page: Page, timeout = 30000) {
  await page.waitForSelector('.ProseMirror, [contenteditable="true"]', { timeout })
}

/**
 * 发送聊天消息
 */
export async function sendChatMessage(page: Page, message: string) {
  // 找到输入框
  const inputLocator = page.locator('.ProseMirror').first()
  await inputLocator.fill(message)

  // 找到发送按钮
  const sendButton = page.locator('button:has-text("发送"), button:has-text("Send")').first()
  await sendButton.click()
}

/**
 * 等待消息响应
 */
export async function waitForResponse(page: Page, timeout = 120000) {
  await page.waitForFunction(
    () => {
      const messages = document.querySelectorAll('[class*="message"], .message')
      return messages.length > 1 // 至少有用户消息和 AI 响应
    },
    { timeout }
  )
}

/**
 * 获取最后一条消息内容
 */
export async function getLastMessage(page: Page): Promise<string> {
  const messages = page.locator('[class*="message"], .message')
  const lastMessage = messages.last()
  return (await lastMessage.textContent()) || ''
}
