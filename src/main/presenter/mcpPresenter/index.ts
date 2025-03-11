import { IMCPPresenter, MCPConfig, MCPServerConfig, MCPToolDefinition } from '@shared/presenter'

// 简化版的 McpPresenter 实现，不依赖外部 SDK
export class McpPresenter implements IMCPPresenter {
  private mcpConfig: MCPConfig = {
    mcpServers: {},
    defaultServer: ''
  }

  constructor() {
    console.log('初始化简化版 MCP Presenter')
  }

  async getMcpConfig(): Promise<MCPConfig> {
    return this.mcpConfig
  }

  async addMcpServer(serverName: string, config: MCPServerConfig): Promise<void> {
    this.mcpConfig.mcpServers[serverName] = config
    if (Object.keys(this.mcpConfig.mcpServers).length === 1) {
      this.mcpConfig.defaultServer = serverName
    }
  }

  async updateMcpServer(serverName: string, config: Partial<MCPServerConfig>): Promise<void> {
    if (this.mcpConfig.mcpServers[serverName]) {
      this.mcpConfig.mcpServers[serverName] = {
        ...this.mcpConfig.mcpServers[serverName],
        ...config
      }
    }
  }

  async removeMcpServer(serverName: string): Promise<void> {
    delete this.mcpConfig.mcpServers[serverName]
    if (this.mcpConfig.defaultServer === serverName) {
      const servers = Object.keys(this.mcpConfig.mcpServers)
      this.mcpConfig.defaultServer = servers.length > 0 ? servers[0] : ''
    }
  }

  async setDefaultServer(serverName: string): Promise<void> {
    if (this.mcpConfig.mcpServers[serverName]) {
      this.mcpConfig.defaultServer = serverName
    }
  }

  async isServerRunning(serverName: string): Promise<boolean> {
    return false // 简化版始终返回 false
  }

  async startServer(serverName: string): Promise<void> {
    console.log(`[MCP] 尝试启动服务器: ${serverName}（简化版仅记录日志）`)
  }

  async stopServer(serverName: string): Promise<void> {
    console.log(`[MCP] 尝试停止服务器: ${serverName}（简化版仅记录日志）`)
  }

  async getAllToolDefinitions(): Promise<MCPToolDefinition[]> {
    return [] // 简化版返回空数组
  }

  async callTool(request: {
    id: string
    type: string
    function: {
      name: string
      arguments: string
    }
  }): Promise<{ content: string }> {
    return { 
      content: `工具调用功能暂不可用 (${request.function.name})`
    }
  }
}
