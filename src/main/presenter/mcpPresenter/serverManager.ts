import { spawn, ChildProcess } from 'child_process'
import { eventBus } from '@/eventbus'
import { MCP_EVENTS } from '@/events'
import { IConfigPresenter } from '@shared/presenter'
import { app } from 'electron'
import path from 'path'

// 确保 TypeScript 能够识别 SERVER_STATUS_CHANGED 属性
// 通过类型断言或接口扩展来解决
// 方法1: 使用类型断言
type MCPEventsType = typeof MCP_EVENTS & {
  SERVER_STATUS_CHANGED: string
}

export class ServerManager {
  private runningServers: Map<string, ChildProcess> = new Map()
  private configPresenter: IConfigPresenter
  private nodeExecutable: string
  private npxExecutable: string

  constructor(configPresenter: IConfigPresenter) {
    this.configPresenter = configPresenter
    const basePath = path.join(app.getAppPath(), 'resources', 'mcp', 'runtime', 'node')
    if (process.env.platform === 'win32') {
      this.nodeExecutable = path.join(basePath, 'node.exe')
    } else {
      this.nodeExecutable = path.join(basePath, 'bin', 'node')
    }
    const npxPath = path.join(basePath, 'bin', 'npx')
    if (process.env.platform === 'win32') {
      this.npxExecutable = path.join(basePath, 'npx.exe')
    } else {
      this.npxExecutable = npxPath
    }
  }

  async startServer(name: string): Promise<void> {
    // 如果服务器已经在运行，则不需要再次启动
    if (this.runningServers.has(name)) {
      // console.log(`MCP服务器 ${name} 已经在运行中`);
      return
    }

    const mcpConfig = await this.configPresenter.getMcpConfig()
    const serverConfig = mcpConfig.mcpServers[name]

    if (!serverConfig) {
      throw new Error(`MCP server ${name} not found`)
    }

    try {
      console.log(`正在启动MCP服务器 ${name}...`)

      const args = [...serverConfig.args]

      // 如果命令是electron，则将命令更改为Node.js
      if (serverConfig.command === 'node' || serverConfig.command === 'electron') {
        serverConfig.command = this.nodeExecutable // runtime Node.js 可执行文件
      }

      if (serverConfig.command === 'npx') {
        serverConfig.command = this.npxExecutable // runtime npx 可执行文件
      }

      // 启动服务器进程
      const serverProcess = spawn(serverConfig.command, args, {
        env: { ...process.env, ...serverConfig.env },
        stdio: 'pipe'
      })

      // 存储进程引用
      this.runningServers.set(name, serverProcess)

      // 监听进程输出
      serverProcess.stdout.on('data', (data) => {
        console.log(`[MCP ${name}] ${data.toString().trim()}`)
      })

      serverProcess.stderr.on('data', (data) => {
        console.error(`[MCP ${name}] Error: ${data.toString().trim()}`)
      })

      // 监听进程退出
      serverProcess.on('close', (code) => {
        console.log(`[MCP ${name}] Process exited with code ${code}`)
        this.runningServers.delete(name)
        // 使用类型断言解决类型检查问题
        eventBus.emit((MCP_EVENTS as MCPEventsType).SERVER_STATUS_CHANGED, {
          name,
          status: 'stopped'
        })
      })

      // 等待服务器启动
      await new Promise<void>((resolve, reject) => {
        // 设置超时
        const timeout = setTimeout(() => {
          reject(new Error(`Timeout starting MCP server ${name}`))
        }, 10000)

        // 监听服务器启动成功的标志
        serverProcess.stdout.on('data', (data) => {
          const output = data.toString()
          if (
            output.includes('Server started') ||
            output.includes('listening') ||
            output.includes('running on stdio')
          ) {
            clearTimeout(timeout)
            console.log(`MCP服务器 ${name} 启动成功`)
            resolve()
          }
        })

        // 也监听stderr，因为一些服务器可能将启动信息输出到stderr
        serverProcess.stderr.on('data', (data) => {
          const output = data.toString()
          if (
            output.includes('Server started') ||
            output.includes('listening') ||
            output.includes('running on stdio')
          ) {
            clearTimeout(timeout)
            console.log(`MCP服务器 ${name} 启动成功`)
            resolve()
          }
        })

        // 监听错误
        serverProcess.on('error', (err) => {
          clearTimeout(timeout)
          console.error(`MCP服务器 ${name} 启动失败:`, err)
          reject(err)
        })
      })

      // 触发服务器状态变更事件
      eventBus.emit((MCP_EVENTS as MCPEventsType).SERVER_STATUS_CHANGED, {
        name,
        status: 'running'
      })
    } catch (error) {
      console.error(`Failed to start MCP server ${name}:`, error)
      throw error
    }
  }

  async stopServer(name: string): Promise<void> {
    const serverProcess = this.runningServers.get(name)

    if (!serverProcess) {
      return
    }

    try {
      // 在Windows上使用taskkill强制终止进程树
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', serverProcess.pid?.toString() || '', '/f', '/t'])
      } else {
        // 在Unix系统上使用SIGTERM信号
        serverProcess.kill('SIGTERM')
      }

      // 从运行中的服务器列表中移除
      this.runningServers.delete(name)

      // 触发服务器状态变更事件
      eventBus.emit((MCP_EVENTS as MCPEventsType).SERVER_STATUS_CHANGED, {
        name,
        status: 'stopped'
      })
    } catch (error: unknown) {
      console.error(`Failed to stop MCP server ${name}:`, error)
      throw error
    }
  }

  async isServerRunning(name: string): Promise<boolean> {
    const isRunning = this.runningServers.has(name)
    // console.log(`MCP服务 ${name} Status:`, isRunning);
    return isRunning
  }
}
