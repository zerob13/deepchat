import { nanoid } from 'nanoid'
import { eventBus } from '@/eventbus'
import { MCP_EVENTS } from '@/events'
import {
  MCPToolCall,
  MCPToolDefinition,
  MCPToolResponse,
  IConfigPresenter
} from '@shared/presenter'
import { ServerManager } from './serverManager'
import { McpClient, getDefaultMcpClient } from './mcpClient'

export class ToolManager {
  private configPresenter: IConfigPresenter
  private serverManager: ServerManager
  private mcpClient: McpClient | null = null

  constructor(configPresenter: IConfigPresenter, serverManager: ServerManager) {
    this.configPresenter = configPresenter
    this.serverManager = serverManager
  }

  // 获取所有工具定义
  public async getAllToolDefinitions(): Promise<MCPToolDefinition[]> {
    if (!this.mcpClient) {
      this.mcpClient = await getDefaultMcpClient()
    }
    const tools = await this.mcpClient.listTools()
    if (!tools) {
      return []
    }
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.entries(tool.inputSchema).reduce(
            (acc, [key, value]) => {
              acc[key] = {
                type: typeof value === 'object' ? 'object' : 'string',
                description: `Parameter ${key}`
              }
              return acc
            },
            {} as Record<string, { type: string; description: string }>
          ),
          required: Object.keys(tool.inputSchema)
        }
      }
    }))
  }

  async callTool(toolCall: MCPToolCall): Promise<MCPToolResponse> {
    console.log('callTool', toolCall)
    try {
      // 获取默认服务器
      const mcpConfig = await this.configPresenter.getMcpConfig()
      const defaultServerName = mcpConfig.defaultServer

      if (!defaultServerName || !mcpConfig.mcpServers[defaultServerName]) {
        throw new Error('No default MCP server configured')
      }

      // 获取服务器配置和权限设置
      const serverConfig = mcpConfig.mcpServers[defaultServerName]
      const autoApprove = serverConfig.autoApprove || []

      // 解析工具调用参数
      const { name, arguments: argsString } = toolCall.function
      let args = {}
      try {
        args = JSON.parse(argsString)
      } catch (error) {
        console.warn('Error parsing tool call arguments:', error)
      }

      // 检查权限
      let hasPermission = false

      // 如果有 'all' 权限，则允许所有操作
      if (autoApprove.includes('all')) {
        hasPermission = true
      } else {
        // 根据操作类型检查特定权限
        switch (name) {
          case 'get_file_content':
          case 'list_directory':
          case 'read_file':
            // 读取操作需要 'read' 权限
            hasPermission = autoApprove.includes('read')
            break
          case 'write_file':
            // 写入操作需要 'write' 权限
            hasPermission = autoApprove.includes('write')
            break
          default:
            // 未知操作默认不授权
            hasPermission = false
        }
      }

      // 如果没有权限，则拒绝操作
      if (!hasPermission) {
        return {
          toolCallId: toolCall.id,
          content: `Error: Operation not permitted. The '${name}' operation requires appropriate permissions.`
        }
      }

      // 确保服务器正在运行
      if (!(await this.serverManager.isServerRunning(defaultServerName))) {
        await this.serverManager.startServer(defaultServerName)
      }

      // 确保 MCP 客户端已初始化
      if (!this.mcpClient) {
        this.mcpClient = await getDefaultMcpClient()
      }

      // 调用 MCP 工具
      const result = await this.mcpClient.callTool(name, args)

      // 返回工具调用结果
      const response: MCPToolResponse = {
        toolCallId: toolCall.id,
        content: result
      }

      // 触发工具调用结果事件
      eventBus.emit(MCP_EVENTS.TOOL_CALL_RESULT, response)

      return response
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('Tool call error:', error)
      return {
        toolCallId: toolCall.id,
        content: `Error: ${errorMessage}`
      }
    }
  }

  // 创建工具调用对象
  createToolCall(toolName: string, args: Record<string, string>): MCPToolCall {
    return {
      id: nanoid(),
      type: 'function',
      function: {
        name: `${toolName}`,
        arguments: JSON.stringify(args)
      }
    }
  }

  // 工具调用处理
  async processToolCalls(message: string): Promise<{
    toolCalls: MCPToolCall[]
    updatedMessage: string
  }> {
    try {
      // 获取默认服务器
      const mcpConfig = await this.configPresenter.getMcpConfig()
      const defaultServerName = mcpConfig.defaultServer

      if (!defaultServerName || !mcpConfig.mcpServers[defaultServerName]) {
        return { toolCalls: [], updatedMessage: message }
      }

      // 分析消息中的工具调用请求
      const toolCalls: MCPToolCall[] = []
      let updatedMessage = message

      // 1. 首先尝试标准格式的工具调用
      const standardToolCallRegex = /我需要使用工具\s*["']([^"']+)["']\s*，参数是\s*({[^}]+})/g
      let match

      while ((match = standardToolCallRegex.exec(message)) !== null) {
        const toolName = match[1]
        const toolArgs = match[2]

        // 创建工具调用对象
        const toolCall: MCPToolCall = {
          id: nanoid(),
          type: 'function',
          function: {
            name: toolName,
            arguments: toolArgs
          }
        }

        toolCalls.push(toolCall)

        // 从消息中移除工具调用请求
        updatedMessage = updatedMessage.replace(match[0], `[使用工具: ${toolName}]`)
      }

      // 2. 如果没有找到标准格式的工具调用，检查是否是模型表达的意图
      if (toolCalls.length === 0) {
        // 检查是否提到了使用某个工具类别
        const toolCategoryRegex = /我(?:需要|会)使用\s+(\w+)\s+工具/i
        const categoryMatch = message.match(toolCategoryRegex)

        if (categoryMatch) {
          const toolCategory = categoryMatch[1].toLowerCase()

          // 根据工具类别和操作类型选择合适的工具
          if (
            toolCategory === 'filesystem' &&
            (message.includes('读取') || message.includes('查看'))
          ) {
            // 尝试提取文件路径
            let filePath = 'hello.txt' // 默认为hello.txt

            // 尝试提取带路径的文件名
            // 1. 先尝试匹配引号中的文件路径
            const quotedPathRegex = /["']([\w\-./\\]+\.\w+)["']/
            let match = message.match(quotedPathRegex)
            if (match) {
              filePath = match[1]
            } else {
              // 2. 尝试匹配中文路径
              const chinesePathRegex = /([\u4e00-\u9fa5\w\-./\\]+\.\w+)/
              match = message.match(chinesePathRegex)
              if (match) {
                filePath = match[1]
              } else {
                // 3. 尝试各种可能的文件格式
                const fileExtensions = ['txt', 'json', 'md', 'js', 'ts', 'py', 'html', 'css']
                for (const ext of fileExtensions) {
                  // 允许路径分隔符和中文字符
                  const regex = new RegExp(`([\\w\\-./\\\\\\u4e00-\\u9fa5]+\\.${ext})`, 'i')
                  match = message.match(regex)
                  if (match) {
                    filePath = match[1]
                    break
                  }
                }
              }
            }

            // 创建工具调用对象
            const toolCall: MCPToolCall = {
              id: nanoid(),
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: filePath })
              }
            }

            toolCalls.push(toolCall)
            updatedMessage = `[使用工具: read_file, 参数: {"path":"${filePath}"}]`
          }
        }
      }

      return { toolCalls, updatedMessage }
    } catch (error: unknown) {
      console.error('Error processing tool calls:', error)
      return { toolCalls: [], updatedMessage: message }
    }
  }
}
