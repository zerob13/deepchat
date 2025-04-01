import { app } from 'electron'
import { presenter } from '@/presenter'
import { IDeeplinkPresenter } from '@shared/presenter'
import path from 'path'

/**
 * DeepLink 处理器类
 * 负责处理 deepchat:// 协议的链接
 * deepchat://start 唤起应用，进入到默认的新会话界面
 * deepchat://start?msg=你好 唤起应用，进入新会话界面，并且带上默认消息
 * deepchat://start?msg=你好&model=deepseek-chat 唤起应用，进入新会话界面，并且带上默认消息，model先进行完全匹配，选中第一个命中的。没有命中的就进行模糊匹配，只要包含这个字段的第一个返回，如果都没有就忽略用默认
 * deepchat://mcp/install?json=base64JSONData 通过json数据直接安装mcp
 */
export class DeeplinkPresenter implements IDeeplinkPresenter {
  init(): void {
    // 注册协议处理器
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('deepchat', process.execPath, [
          path.resolve(process.argv[1])
        ])
      }
    } else {
      app.setAsDefaultProtocolClient('deepchat')
    }

    // 处理 macOS 上协议被调用的情况
    app.on('open-url', (event, url) => {
      event.preventDefault()
      this.handleDeepLink(url)
    })

    // 处理 Windows 上协议被调用的情况
    const gotTheLock = app.requestSingleInstanceLock()
    if (!gotTheLock) {
      app.quit()
    } else {
      app.on('second-instance', (_event, commandLine) => {
        // 用户尝试运行第二个实例，我们应该聚焦到我们的窗口
        if (presenter.windowPresenter.mainWindow) {
          if (presenter.windowPresenter.mainWindow.isMinimized()) {
            presenter.windowPresenter.mainWindow.restore()
          }
          presenter.windowPresenter.mainWindow.show()
          presenter.windowPresenter.mainWindow.focus()
        }
        if (process.platform === 'win32') {
          // 在 Windows 上，命令行参数包含协议 URL
          const deepLinkUrl = commandLine.find((arg) => arg.startsWith('deepchat://'))
          if (deepLinkUrl) {
            this.handleDeepLink(deepLinkUrl)
          }
        }
      })
    }
  }

  async handleDeepLink(url: string): Promise<void> {
    console.log('收到 DeepLink:', url)

    try {
      const urlObj = new URL(url)

      if (urlObj.protocol !== 'deepchat:') {
        console.error('不支持的协议:', urlObj.protocol)
        return
      }
      // TODO: 解析bug，目前解析的是错的
      console.log('pathname:', urlObj.pathname)
      const pathname = urlObj.pathname.replace(/^\/+/, '') // 移除开头的斜杠
      const searchParams = urlObj.searchParams

      if (pathname === 'start') {
        await this.handleStart(searchParams)
      } else if (pathname === 'mcp/install') {
        await this.handleMcpInstall(searchParams)
      } else {
        console.warn('未知的 DeepLink 路径:', pathname)
      }
    } catch (error) {
      console.error('处理 DeepLink 时出错:', error)
    }
  }

  async handleStart(params: URLSearchParams): Promise<void> {
    console.log('处理 start 命令，参数:', Object.fromEntries(params.entries()))

    let msg = params.get('msg')
    if (!msg) {
      return
    }
    msg = decodeURIComponent(msg)
    // 如果有模型参数，尝试设置
    let modelId = params.get('model')
    if (modelId && modelId.trim() !== '') {
      modelId = decodeURIComponent(modelId)
    }
    console.log('msg:', msg)
    console.log('modelId:', modelId)
    //TODO： 抛事件给render创建新会话
  }

  async handleMcpInstall(params: URLSearchParams): Promise<void> {
    console.log('处理 mcp/install 命令，参数:', Object.fromEntries(params.entries()))

    // 获取 JSON 数据
    const jsonBase64 = params.get('json')
    if (!jsonBase64) {
      console.error('缺少 json 参数')
      return
    }

    try {
      // 解码 Base64 并解析 JSON
      const jsonString = Buffer.from(decodeURIComponent(jsonBase64), 'base64').toString('utf-8')
      const mcpConfig = JSON.parse(jsonString)

      // 检查 MCP 配置是否有效
      if (!mcpConfig || !mcpConfig.name || !mcpConfig.config) {
        console.error('无效的 MCP 配置')
        return
      }

      //TODO: 安装 MCP 服务器

      console.log('安装 MCP 服务器:', mcpConfig)
    } catch (error) {
      console.error('解析或安装 MCP 配置时出错:', error)
    }
  }
}
