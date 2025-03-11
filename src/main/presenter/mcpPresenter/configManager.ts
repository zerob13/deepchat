import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { eventBus } from '@/eventbus'
import { MCP_EVENTS } from '@/events'
import { MCPConfig, MCPServerConfig } from '@shared/presenter'

// MCP配置文件路径
export const MCP_CONFIG_FILE = path.join(app.getAppPath(), 'resources', 'mcp', 'mcpConfig.json');

// 最小化基础配置
export const MIN_CONFIG: MCPConfig = {
  mcpServers: {},
  defaultServer: ''
}

export class ConfigManager {
  constructor() {
    this.initMcpConfigFile()
  }

  // 初始化MCP配置文件
  private initMcpConfigFile(): void {
    try {
      const templatePath = path.join(app.getAppPath(), 'resources', 'mcp', 'mcpConfig.json')
      
      // 检查配置文件是否存在
      if (!fs.existsSync(MCP_CONFIG_FILE)) {
        // 如果模板文件存在，则复制模板文件
        if (fs.existsSync(templatePath)) {
          const templateConfig = JSON.parse(fs.readFileSync(templatePath, 'utf-8'))
          fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(templateConfig, null, 2), 'utf-8')
          console.log('已从模板创建MCP配置文件:', MCP_CONFIG_FILE)
        } else {
          // 如果模板文件不存在，则使用最小化配置
          fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(MIN_CONFIG, null, 2), 'utf-8')
          console.log('已使用最小化配置创建MCP配置文件:', MCP_CONFIG_FILE)
        }
      }
    } catch (error) {
      console.error('初始化MCP配置文件失败:', error)
    }
  }

  // 配置管理
  async getMcpConfig(): Promise<MCPConfig> {
    try {
      if (fs.existsSync(MCP_CONFIG_FILE)) {
        const fileConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf-8'))
        return fileConfig
      }
    } catch (error) {
      console.error('从文件读取MCP配置失败:', error)
    }
    
    // 如果文件不存在或读取失败，则返回最小化配置
    return MIN_CONFIG
  }

  async setMcpConfig(config: MCPConfig): Promise<void> {
    try {
      fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
      console.log('已更新MCP配置文件:', MCP_CONFIG_FILE)
      eventBus.emit(MCP_EVENTS.CONFIG_CHANGED, config)
    } catch (error) {
      console.error('更新MCP配置文件失败:', error)
      throw error
    }
  }

  async addMcpServer(name: string, config: MCPServerConfig): Promise<void> {
    const mcpConfig = await this.getMcpConfig()
    mcpConfig.mcpServers[name] = config
    await this.setMcpConfig(mcpConfig)
  }

  async removeMcpServer(name: string): Promise<void> {
    const mcpConfig = await this.getMcpConfig()
    delete mcpConfig.mcpServers[name]
    await this.setMcpConfig(mcpConfig)
  }

  async updateMcpServer(name: string, config: Partial<MCPServerConfig>): Promise<void> {
    const mcpConfig = await this.getMcpConfig()
    
    // 确保服务器存在
    if (!mcpConfig.mcpServers[name]) {
      throw new Error(`MCP server ${name} not found`)
    }
    
    // 更新配置
    mcpConfig.mcpServers[name] = {
      ...mcpConfig.mcpServers[name],
      ...config
    }
    
    await this.setMcpConfig(mcpConfig)
  }

  async setDefaultServer(name: string): Promise<void> {
    const mcpConfig = await this.getMcpConfig()
    
    // 确保服务器存在
    if (!mcpConfig.mcpServers[name]) {
      throw new Error(`MCP server ${name} not found`)
    }
    
    mcpConfig.defaultServer = name
    await this.setMcpConfig(mcpConfig)
  }

  // 获取MCP配置文件路径
  getMcpConfigFilePath(): string {
    return MCP_CONFIG_FILE
  }

  // 直接从文件加载MCP配置
  async loadMcpConfigFromFile(): Promise<MCPConfig | null> {
    try {
      if (fs.existsSync(MCP_CONFIG_FILE)) {
        const fileConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf-8'))
        console.log('已从文件重新加载MCP配置')
        return fileConfig
      }
    } catch (error) {
      console.error('从文件加载MCP配置失败:', error)
    }
    return null
  }
}
