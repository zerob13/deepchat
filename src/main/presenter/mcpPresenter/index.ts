import {
  IMCPPresenter,
  MCPConfig,
  MCPServerConfig,
  MCPToolDefinition,
  MCPToolCall
} from '@shared/presenter'
import { ServerManager } from './serverManager'
import { ToolManager } from './toolManager'
import { eventBus } from '@/eventbus'
import { MCP_EVENTS } from '@/events'
import { IConfigPresenter } from '@shared/presenter'

// 定义MCP工具接口
interface MCPTool {
  id: string
  name: string
  type: string
  description: string
  serverName: string
  inputSchema: {
    properties: Record<string, Record<string, unknown>>
    [key: string]: unknown
  }
}

// 定义各家LLM的工具类型接口
interface OpenAIToolCall {
  function: {
    name: string
    arguments: string
  }
}

interface AnthropicToolUse {
  name: string
  input: Record<string, unknown>
}

interface GeminiFunctionCall {
  name: string
  args: Record<string, unknown>
}

// 定义工具转换接口
interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: string
      properties: Record<string, Record<string, unknown>>
    }
  }
}

interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: string
    properties: Record<string, Record<string, unknown>>
  }
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: {
      type: string
      properties: Record<string, Record<string, unknown>>
    }
  }>
}

// 完整版的 McpPresenter 实现
export class McpPresenter implements IMCPPresenter {
  private serverManager: ServerManager
  private toolManager: ToolManager
  private configPresenter: IConfigPresenter

  constructor(configPresenter?: IConfigPresenter) {
    console.log('初始化 MCP Presenter')

    // 如果提供了configPresenter实例，则使用它，否则保持与当前方式兼容
    if (configPresenter) {
      this.configPresenter = configPresenter
    } else {
      // 这里需要处理项目环境下的循环引用问题，通过延迟初始化解决
      // McpPresenter会在Presenter初始化过程中创建，此时presenter还不可用
      // 我们在initialize方法中会设置configPresenter
      this.configPresenter = {} as IConfigPresenter
    }

    this.serverManager = new ServerManager(this.configPresenter)
    this.toolManager = new ToolManager(this.configPresenter, this.serverManager)

    // 应用启动时初始化
    this.initialize()
  }

  private async initialize() {
    try {
      // 如果没有提供configPresenter，从presenter中获取
      if (!this.configPresenter.getLanguage) {
        // 通过动态导入解决循环依赖
        const { presenter } = await import('@/presenter')
        this.configPresenter = presenter.configPresenter

        // 重新创建管理器
        this.serverManager = new ServerManager(this.configPresenter)
        this.toolManager = new ToolManager(this.configPresenter, this.serverManager)
      }

      // 加载配置
      const config = await this.configPresenter.getMcpConfig()

      // 如果有默认服务器，尝试启动
      if (config.defaultServer && config.mcpServers[config.defaultServer]) {
        const serverName = config.defaultServer
        console.log(`[MCP] 尝试启动默认服务器: ${serverName}`)

        try {
          await this.serverManager.startServer(serverName)
          console.log(`[MCP] 默认服务器 ${serverName} 启动成功`)

          // 通知渲染进程服务器已启动
          eventBus.emit(MCP_EVENTS.SERVER_STARTED, serverName)
        } catch (error) {
          console.error(`[MCP] 默认服务器 ${serverName} 启动失败:`, error)
        }
      }
    } catch (error) {
      console.error('[MCP] 初始化失败:', error)
    }
  }

  async getMcpConfig(): Promise<MCPConfig> {
    return this.configPresenter.getMcpConfig()
  }

  async addMcpServer(serverName: string, config: MCPServerConfig): Promise<void> {
    await this.configPresenter.addMcpServer(serverName, config)
  }

  async updateMcpServer(serverName: string, config: Partial<MCPServerConfig>): Promise<void> {
    await this.configPresenter.updateMcpServer(serverName, config)
  }

  async removeMcpServer(serverName: string): Promise<void> {
    // 如果服务器正在运行，先停止
    if (await this.isServerRunning(serverName)) {
      await this.stopServer(serverName)
    }

    await this.configPresenter.removeMcpServer(serverName)
  }

  async setDefaultServer(serverName: string): Promise<void> {
    await this.configPresenter.setDefaultServer(serverName)
  }

  async isServerRunning(serverName: string): Promise<boolean> {
    return this.serverManager.isServerRunning(serverName)
  }

  async startServer(serverName: string): Promise<void> {
    await this.serverManager.startServer(serverName)
  }

  async stopServer(serverName: string): Promise<void> {
    await this.serverManager.stopServer(serverName)
  }

  async getAllToolDefinitions(): Promise<MCPToolDefinition[]> {
    return this.toolManager.getAllToolDefinitions()
  }

  async callTool(request: MCPToolCall): Promise<{ content: string }> {
    return this.toolManager.callTool(request)
  }

  // 将MCPToolDefinition转换为MCPTool
  private mcpToolDefinitionToMcpTool(
    toolDefinition: MCPToolDefinition,
    serverName: string
  ): MCPTool {
    const openaiTool = {
      id: toolDefinition.function.name,
      name: toolDefinition.function.name,
      type: toolDefinition.type,
      description: toolDefinition.function.description,
      serverName,
      inputSchema: {
        properties: toolDefinition.function.parameters.properties as Record<
          string,
          Record<string, unknown>
        >,
        type: toolDefinition.function.parameters.type,
        required: toolDefinition.function.parameters.required
      }
    }
    console.log('openaiTool', toolDefinition, openaiTool)
    return openaiTool
  }

  // 工具属性过滤函数
  private filterPropertieAttributes(tool: MCPTool): Record<string, Record<string, unknown>> {
    const supportedAttributes = [
      'type',
      'nullable',
      'required',
      'description',
      'properties',
      'items',
      'enum',
      'anyOf'
    ]

    const properties = tool.inputSchema.properties
    const getSubMap = (obj: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
      return Object.fromEntries(Object.entries(obj).filter(([key]) => keys.includes(key)))
    }

    const result: Record<string, Record<string, unknown>> = {}
    for (const [key, val] of Object.entries(properties)) {
      result[key] = getSubMap(val, supportedAttributes)
    }
    return result
  }

  // 新增工具转换方法
  /**
   * 将MCP工具定义转换为OpenAI工具格式
   * @param mcpTools MCP工具定义数组
   * @param serverName 服务器名称
   * @returns OpenAI工具格式的工具定义
   */
  async mcpToolsToOpenAITools(
    mcpTools: MCPToolDefinition[],
    serverName: string
  ): Promise<OpenAITool[]> {
    return mcpTools.map((toolDef) => {
      const tool = this.mcpToolDefinitionToMcpTool(toolDef, serverName)
      return {
        type: 'function',
        function: {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: this.filterPropertieAttributes(tool)
          }
        }
      }
    })
  }

  /**
   * 将OpenAI工具调用转换回MCP工具调用
   * @param mcpTools MCP工具定义数组
   * @param llmTool OpenAI工具调用
   * @param serverName 服务器名称
   * @returns 匹配的MCP工具调用
   */
  async openAIToolsToMcpTool(
    mcpTools: MCPToolDefinition[] | undefined,
    llmTool: OpenAIToolCall,
    serverName: string
  ): Promise<MCPToolCall | undefined> {
    if (!mcpTools) return undefined

    const tool = mcpTools.find((tool) => tool.function.name === llmTool.function.name)
    if (!tool) {
      return undefined
    }

    // 创建MCP工具调用
    const mcpToolCall: MCPToolCall = {
      id: `${serverName}:${tool.function.name}-${Date.now()}`, // 生成唯一ID，包含服务器名称
      type: tool.type,
      function: {
        name: tool.function.name,
        arguments: llmTool.function.arguments
      }
    }

    return mcpToolCall
  }

  /**
   * 将MCP工具定义转换为Anthropic工具格式
   * @param mcpTools MCP工具定义数组
   * @param serverName 服务器名称
   * @returns Anthropic工具格式的工具定义
   */
  async mcpToolsToAnthropicTools(
    mcpTools: MCPToolDefinition[],
    serverName: string
  ): Promise<AnthropicTool[]> {
    return mcpTools.map((toolDef) => {
      const tool = this.mcpToolDefinitionToMcpTool(toolDef, serverName)
      return {
        name: tool.id,
        description: tool.description,
        input_schema: {
          type: 'object',
          properties: this.filterPropertieAttributes(tool)
        }
      }
    })
  }

  /**
   * 将Anthropic工具使用转换回MCP工具调用
   * @param mcpTools MCP工具定义数组
   * @param toolUse Anthropic工具使用
   * @param serverName 服务器名称
   * @returns 匹配的MCP工具调用
   */
  async anthropicToolUseToMcpTool(
    mcpTools: MCPToolDefinition[] | undefined,
    toolUse: AnthropicToolUse,
    serverName: string
  ): Promise<MCPToolCall | undefined> {
    if (!mcpTools) return undefined

    const tool = mcpTools.find((tool) => tool.function.name === toolUse.name)
    if (!tool) {
      return undefined
    }

    // 创建MCP工具调用
    const mcpToolCall: MCPToolCall = {
      id: `${serverName}:${tool.function.name}-${Date.now()}`, // 生成唯一ID，包含服务器名称
      type: tool.type,
      function: {
        name: tool.function.name,
        arguments: JSON.stringify(toolUse.input)
      }
    }

    return mcpToolCall
  }

  /**
   * 将MCP工具定义转换为Gemini工具格式
   * @param mcpTools MCP工具定义数组
   * @param serverName 服务器名称
   * @returns Gemini工具格式的工具定义
   */
  async mcpToolsToGeminiTools(
    mcpTools: MCPToolDefinition[] | undefined,
    serverName: string
  ): Promise<GeminiTool[]> {
    if (!mcpTools || mcpTools.length === 0) {
      return []
    }

    const functionDeclarations = mcpTools.map((toolDef) => {
      const tool = this.mcpToolDefinitionToMcpTool(toolDef, serverName)
      return {
        name: tool.id,
        description: tool.description,
        parameters: {
          type: 'OBJECT', // Gemini期望的格式
          properties: this.filterPropertieAttributes(tool)
        }
      }
    })

    return [
      {
        functionDeclarations
      }
    ]
  }

  /**
   * 将Gemini函数调用转换回MCP工具调用
   * @param mcpTools MCP工具定义数组
   * @param fcall Gemini函数调用
   * @param serverName 服务器名称
   * @returns 匹配的MCP工具调用
   */
  async geminiFunctionCallToMcpTool(
    mcpTools: MCPToolDefinition[] | undefined,
    fcall: GeminiFunctionCall | undefined,
    serverName: string
  ): Promise<MCPToolCall | undefined> {
    if (!fcall) return undefined
    if (!mcpTools) return undefined

    const tool = mcpTools.find((tool) => tool.function.name === fcall.name)
    if (!tool) {
      return undefined
    }

    // 创建MCP工具调用
    const mcpToolCall: MCPToolCall = {
      id: `${serverName}:${tool.function.name}-${Date.now()}`, // 生成唯一ID，包含服务器名称
      type: tool.type,
      function: {
        name: tool.function.name,
        arguments: JSON.stringify(fcall.args)
      }
    }

    return mcpToolCall
  }
}
