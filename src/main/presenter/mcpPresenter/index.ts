import { IMCPPresenter, MCPConfig, MCPServerConfig, MCPToolDefinition } from '@shared/presenter'
import { ConfigManager } from './configManager'
import { ServerManager } from './serverManager'
import { ToolManager } from './toolManager'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { eventBus } from '@/eventbus'
import { MCP_EVENTS } from '@/events'

// 完整版的 McpPresenter 实现
export class McpPresenter implements IMCPPresenter {
  private configManager: ConfigManager
  private serverManager: ServerManager
  private toolManager: ToolManager
  private isInitialized = false

  constructor() {
    console.log('初始化 MCP Presenter')
    this.configManager = new ConfigManager()
    this.serverManager = new ServerManager(this.configManager)
    this.toolManager = new ToolManager(this.configManager, this.serverManager)
    
    // 应用启动时初始化
    this.initialize()
  }

  private async initialize() {
    try {
      // 加载配置
      const config = await this.configManager.getMcpConfig()
      
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
      
      this.isInitialized = true
    } catch (error) {
      console.error('[MCP] 初始化失败:', error)
    }
  }

  async getMcpConfig(): Promise<MCPConfig> {
    return this.configManager.getMcpConfig()
  }

  async addMcpServer(serverName: string, config: MCPServerConfig): Promise<void> {
    await this.configManager.addMcpServer(serverName, config)
  }

  async updateMcpServer(serverName: string, config: Partial<MCPServerConfig>): Promise<void> {
    await this.configManager.updateMcpServer(serverName, config)
  }

  async removeMcpServer(serverName: string): Promise<void> {
    // 如果服务器正在运行，先停止
    if (await this.isServerRunning(serverName)) {
      await this.stopServer(serverName)
    }
    
    await this.configManager.removeMcpServer(serverName)
  }

  async setDefaultServer(serverName: string): Promise<void> {
    await this.configManager.setDefaultServer(serverName)
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

  async callTool(request: {
    id: string
    type: string
    function: {
      name: string
      arguments: string
    }
  }): Promise<{ content: string }> {
    return this.toolManager.callTool(request)
  }
}
