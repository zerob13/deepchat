import { eventBus } from '@/eventbus'
import { MCPServerConfig } from '@shared/presenter'
import { MCP_EVENTS } from '@/events'
import ElectronStore from 'electron-store'
import { app } from 'electron'

// MCP设置的接口
interface IMcpSettings {
  mcpServers: Record<string, MCPServerConfig>
  defaultServer: string
  mcpEnabled: boolean // 添加MCP启用状态字段
  [key: string]: unknown // 允许任意键
}
export type MCPServerType = 'stdio' | 'sse' | 'inmemory'
// const filesystemPath = path.join(app.getAppPath(), 'resources', 'mcp', 'filesystem.mjs')
const DEFAULT_MCP_SERVERS = {
  mcpServers: {
    inMemoryFileSystem: {
      args: [app.getPath('home')],
      descriptions: '内置文件系统mcp服务',
      icons: '💾',
      autoApprove: ['read'],
      type: 'inmemory' as MCPServerType,
      command: 'filesystem',
      env: {},
      disable: false
    },
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', app.getPath('home')],
      env: {},
      descriptions: '',
      icons: '📁',
      autoApprove: ['read'],
      type: 'stdio' as MCPServerType,
      disable: true
    },
    memory: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: {},
      descriptions: '内存存储服务',
      icons: '🧠',
      autoApprove: ['all'],
      disable: true,
      type: 'stdio' as MCPServerType
    },
    bitcoin: {
      command: 'npx',
      args: ['-y', 'bitcoin-mcp@latest'],
      env: {},
      descriptions: '查询比特币',
      icons: '💰',
      autoApprove: ['all'],
      type: 'stdio' as MCPServerType
    },
    airbnb: {
      descriptions: 'Airbnb',
      icons: '🏠',
      autoApprove: ['all'],
      type: 'stdio' as MCPServerType,
      command: 'npx',
      args: ['-y', '@openbnb/mcp-server-airbnb', '--ignore-robots-txt'],
      env: {}
    }
  },
  defaultServer: 'inMemoryFileSystem',
  mcpEnabled: false // 默认关闭MCP功能
}

export class McpConfHelper {
  private mcpStore: ElectronStore<IMcpSettings>

  constructor() {
    // 初始化MCP设置存储
    this.mcpStore = new ElectronStore<IMcpSettings>({
      name: 'mcp-settings',
      defaults: {
        mcpServers: DEFAULT_MCP_SERVERS.mcpServers,
        defaultServer: DEFAULT_MCP_SERVERS.defaultServer,
        mcpEnabled: DEFAULT_MCP_SERVERS.mcpEnabled
      }
    })
  }

  // 获取MCP服务器配置
  getMcpServers(): Promise<Record<string, MCPServerConfig>> {
    return Promise.resolve(this.mcpStore.get('mcpServers') || DEFAULT_MCP_SERVERS.mcpServers)
  }

  // 设置MCP服务器配置
  async setMcpServers(servers: Record<string, MCPServerConfig>): Promise<void> {
    this.mcpStore.set('mcpServers', servers)
    eventBus.emit(MCP_EVENTS.CONFIG_CHANGED, {
      mcpServers: servers,
      defaultServer: this.mcpStore.get('defaultServer'),
      mcpEnabled: this.mcpStore.get('mcpEnabled')
    })
  }

  // 获取默认服务器
  getMcpDefaultServer(): Promise<string> {
    return Promise.resolve(this.mcpStore.get('defaultServer') || DEFAULT_MCP_SERVERS.defaultServer)
  }

  // 设置默认服务器
  async setMcpDefaultServer(serverName: string): Promise<void> {
    this.mcpStore.set('defaultServer', serverName)
    eventBus.emit(MCP_EVENTS.CONFIG_CHANGED, {
      mcpServers: this.mcpStore.get('mcpServers'),
      defaultServer: serverName,
      mcpEnabled: this.mcpStore.get('mcpEnabled')
    })
  }

  // 获取MCP启用状态
  getMcpEnabled(): Promise<boolean> {
    return Promise.resolve(this.mcpStore.get('mcpEnabled') ?? DEFAULT_MCP_SERVERS.mcpEnabled)
  }

  // 设置MCP启用状态
  async setMcpEnabled(enabled: boolean): Promise<void> {
    this.mcpStore.set('mcpEnabled', enabled)
    eventBus.emit(MCP_EVENTS.CONFIG_CHANGED, {
      mcpServers: this.mcpStore.get('mcpServers'),
      defaultServer: this.mcpStore.get('defaultServer'),
      mcpEnabled: enabled
    })
  }

  // 添加MCP服务器
  async addMcpServer(name: string, config: MCPServerConfig): Promise<void> {
    const mcpServers = await this.getMcpServers()
    mcpServers[name] = config
    await this.setMcpServers(mcpServers)
  }

  // 移除MCP服务器
  async removeMcpServer(name: string): Promise<void> {
    const mcpServers = await this.getMcpServers()
    delete mcpServers[name]
    await this.setMcpServers(mcpServers)

    // 如果删除的是默认服务器，则清空默认服务器设置
    const defaultServer = await this.getMcpDefaultServer()
    if (defaultServer === name) {
      await this.setMcpDefaultServer('')
    }
  }

  // 更新MCP服务器配置
  async updateMcpServer(name: string, config: Partial<MCPServerConfig>): Promise<void> {
    const mcpServers = await this.getMcpServers()
    if (!mcpServers[name]) {
      throw new Error(`MCP server ${name} not found`)
    }
    mcpServers[name] = {
      ...mcpServers[name],
      ...config
    }
    await this.setMcpServers(mcpServers)
  }

  // 恢复默认服务器配置
  async resetToDefaultServers(): Promise<void> {
    const currentServers = await this.getMcpServers()
    const updatedServers = { ...currentServers }

    // 遍历所有默认服务，有则覆盖，无则新增
    for (const [serverName, serverConfig] of Object.entries(DEFAULT_MCP_SERVERS.mcpServers)) {
      updatedServers[serverName] = serverConfig
    }

    // 更新服务器配置
    await this.setMcpServers(updatedServers)

    // 恢复默认服务器设置
    await this.setMcpDefaultServer(DEFAULT_MCP_SERVERS.defaultServer)
  }
}
