import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path from 'path'
import { presenter } from '@/presenter'

// 定义工具调用结果的接口
interface ToolCallResult {
  isError?: boolean
  content: Array<{
    type: string
    text: string
  }>
}

// 定义工具列表的接口
interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// 定义资源的接口
interface Resource {
  uri: string
  text: string
}

// MCP 客户端类
export class McpClient {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private serverName: string
  private serverConfig: Record<string, unknown>
  private isConnected: boolean = false
  private workingDirectory: string | null = null

  constructor(serverName: string, serverConfig: Record<string, unknown>) {
    this.serverName = serverName
    this.serverConfig = serverConfig

    // 从配置中获取工作目录
    if (Array.isArray(serverConfig.args) && serverConfig.args.length > 1) {
      this.workingDirectory = serverConfig.args[1] as string
    }
  }

  // 连接到 MCP 服务器
  async connect(): Promise<void> {
    if (this.isConnected) {
      return
    }

    try {
      // 获取 Electron 内置的 Node.js 可执行文件路径
      const nodePath = process.execPath // Electron 的 Node.js 可执行文件

      // 创建 StdioClientTransport
      this.transport = new StdioClientTransport({
        command: nodePath,
        args: this.serverConfig.args as string[],
        env: (this.serverConfig.env as Record<string, string>) || {}
      })

      // 创建 MCP 客户端
      this.client = new Client(
        { name: 'MCP Client', version: '1.0.0' },
        { capabilities: { tools: {}, resources: {} } }
      )

      // 连接到服务器
      await this.client.connect(this.transport)
      this.isConnected = true
      console.log(`Connected to MCP server: ${this.serverName}`, this.transport)
    } catch (error) {
      console.error(`Failed to connect to MCP server ${this.serverName}:`, error)
      this.isConnected = false
      throw error
    }
  }

  // 断开与 MCP 服务器的连接
  async disconnect(): Promise<void> {
    if (!this.isConnected || !this.client) {
      return
    }

    try {
      // 关闭传输连接
      if (this.transport) {
        await this.transport.close()
      }
      this.isConnected = false
      console.log(`Disconnected from MCP server: ${this.serverName}`)
    } catch (error) {
      console.error(`Failed to disconnect from MCP server ${this.serverName}:`, error)
      throw error
    } finally {
      this.client = null
      this.transport = null
    }
  }

  // 调用 MCP 工具
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.isConnected) {
      await this.connect()
    }

    if (!this.client) {
      throw new Error(`MCP client for ${this.serverName} is not initialized`)
    }

    try {
      // 处理路径参数
      const processedArgs = { ...args }
      if (this.workingDirectory && 'path' in processedArgs) {
        const userPath = processedArgs.path as string
        // 如果用户提供的不是绝对路径，则将其视为相对于工作目录的路径
        if (!path.isAbsolute(userPath)) {
          processedArgs.path = path.join(this.workingDirectory, userPath)
        }
      }

      // 调用工具
      const result = (await this.client.callTool({
        name: toolName,
        arguments: processedArgs
      })) as ToolCallResult

      // 检查结果
      if (result.isError) {
        const errorText =
          result.content && result.content[0] ? result.content[0].text : 'Unknown error'
        throw new Error(`Tool ${toolName} returned an error: ${errorText}`)
      }

      // 返回结果文本
      return result.content && result.content[0] ? result.content[0].text : ''
    } catch (error) {
      console.error(`Failed to call MCP tool ${toolName}:`, error)
      throw error
    }
  }

  // 列出可用工具
  async listTools(): Promise<Tool[]> {
    if (!this.isConnected) {
      await this.connect()
    }

    if (!this.client) {
      throw new Error(`MCP client for ${this.serverName} is not initialized`)
    }

    try {
      const response = await this.client.listTools()
      // 检查响应格式
      if (response && typeof response === 'object' && 'tools' in response) {
        const toolsArray = response.tools
        if (Array.isArray(toolsArray)) {
          return toolsArray as Tool[]
        }
      }
      throw new Error('Invalid tools response format')
    } catch (error) {
      console.error(`Failed to list MCP tools:`, error)
      throw error
    }
  }

  // 读取资源
  async readResource(resourceUri: string): Promise<Resource> {
    if (!this.isConnected) {
      await this.connect()
    }

    if (!this.client) {
      throw new Error(`MCP client for ${this.serverName} is not initialized`)
    }

    try {
      // 使用 unknown 作为中间类型进行转换
      const rawResource = (await this.client.readResource({ uri: resourceUri })) as unknown

      // 手动构造 Resource 对象
      const resource: Resource = {
        uri: resourceUri,
        text:
          typeof rawResource === 'object' && rawResource !== null && 'text' in rawResource
            ? String(rawResource['text'])
            : JSON.stringify(rawResource)
      }

      return resource
    } catch (error) {
      console.error(`Failed to read MCP resource ${resourceUri}:`, error)
      throw error
    }
  }
}

// 工厂函数，用于创建 MCP 客户端
export async function createMcpClient(serverName: string): Promise<McpClient> {
  // 从configPresenter获取MCP配置
  const mcpConfig = await presenter.configPresenter.getMcpConfig()

  // 获取服务器配置
  const serverConfig = mcpConfig.mcpServers[serverName]
  if (!serverConfig) {
    throw new Error(`MCP server ${serverName} not found in configuration`)
  }

  // 创建并返回 MCP 客户端
  return new McpClient(serverName, serverConfig as unknown as Record<string, unknown>)
}

// 获取默认 MCP 客户端
export async function getDefaultMcpClient(): Promise<McpClient> {
  // 从configPresenter获取MCP配置
  const mcpConfig = await presenter.configPresenter.getMcpConfig()

  // 获取默认服务器名称
  const defaultServerName = mcpConfig.defaultServer
  if (!defaultServerName) {
    throw new Error('No default MCP server configured')
  }

  // 创建并返回默认 MCP 客户端
  return createMcpClient(defaultServerName)
}

// 示例调用
// (async () => {
//   try {
//     const client = await getDefaultMcpClient();
//     const result = await client.callTool("read_file", { path: "example.txt" });
//     console.log("MCP Result:", result);
//     await client.disconnect();
//   } catch (error) {
//     console.error("Error:", error);
//   }
// })();
