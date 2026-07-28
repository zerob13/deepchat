import { beforeEach, describe, expect, it, vi } from 'vitest'

const publishDeepchatEventMock = vi.hoisted(() => vi.fn())

const clientMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  isActive: vi.fn(),
  isServerRunning: vi.fn(),
  getLifecycleStatus: vi.fn(),
  getConnectionCompletion: vi.fn(),
  McpConnectionCancelledError: class McpConnectionCancelledError extends Error {
    constructor(serverName: string) {
      super(`Connection to MCP server ${serverName} was cancelled`)
      this.name = 'McpConnectionCancelledError'
    }
  }
}))

vi.mock('@/platform/proxy', () => ({
  proxyConfig: {
    getProxyUrl: vi.fn(() => '')
  }
}))

vi.mock('@/mcp/mcpClient', () => ({
  McpClient: vi.fn().mockImplementation((_name, serverConfig) => ({
    connect: clientMocks.connect,
    disconnect: clientMocks.disconnect,
    isActive: clientMocks.isActive,
    isServerRunning: clientMocks.isServerRunning,
    getLifecycleStatus: clientMocks.getLifecycleStatus,
    serverConfig,
    getConnectionCompletion: clientMocks.getConnectionCompletion
  })),
  McpConnectionCancelledError: clientMocks.McpConnectionCancelledError
}))

import { ServerManager } from '@/mcp/serverManager'
import { McpClient, McpConnectionCancelledError } from '@/mcp/mcpClient'

describe('ServerManager plugin MCP errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientMocks.connect.mockResolvedValue('connected')
    clientMocks.disconnect.mockResolvedValue(undefined)
    clientMocks.isActive.mockReturnValue(false)
    clientMocks.isServerRunning.mockReturnValue(true)
    clientMocks.getLifecycleStatus.mockReturnValue('ready')
    clientMocks.getConnectionCompletion.mockReturnValue(null)
    vi.mocked(McpClient).mockImplementation(
      (_name, serverConfig) =>
        ({
          connect: clientMocks.connect,
          disconnect: clientMocks.disconnect,
          isActive: clientMocks.isActive,
          isServerRunning: clientMocks.isServerRunning,
          getLifecycleStatus: clientMocks.getLifecycleStatus,
          serverConfig,
          getConnectionCompletion: clientMocks.getConnectionCompletion
        }) as never
    )
  })

  function createProviderSettings(servers: Record<string, any>) {
    return {
      getMcpServers: vi.fn().mockResolvedValue(servers),
      getLanguage: vi.fn().mockReturnValue('en-US'),
      getEffectiveNpmRegistry: vi.fn().mockReturnValue(null)
    }
  }

  it('suppresses global connection toasts for plugin-owned MCP servers', async () => {
    const providerSettings = createProviderSettings({
      plugin: {
        command: 'plugin-command',
        args: [],
        env: {},
        type: 'stdio',
        source: 'plugin',
        ownerPluginId: 'com.deepchat.fixture'
      }
    })
    const manager = new ServerManager(
      { getLanguage: vi.fn().mockReturnValue('en-US') },
      providerSettings as never,
      { isEnabled: () => false },
      vi.fn() as never,
      {} as never,
      vi.fn(),
      publishDeepchatEventMock
    )
    clientMocks.connect.mockRejectedValueOnce(new Error('connect failed'))

    await expect(manager.startServer('plugin')).rejects.toThrow('connect failed')

    expect(manager.getServerLastError('plugin')).toBe('connect failed')
    expect(publishDeepchatEventMock).not.toHaveBeenCalled()
  })

  it('keeps global connection toasts for normal MCP servers', async () => {
    const providerSettings = createProviderSettings({
      regular: {
        command: 'regular-command',
        args: [],
        env: {},
        type: 'stdio'
      }
    })
    const manager = new ServerManager(
      { getLanguage: vi.fn().mockReturnValue('en-US') },
      providerSettings as never,
      { isEnabled: () => false },
      vi.fn() as never,
      {} as never,
      vi.fn(),
      publishDeepchatEventMock
    )
    clientMocks.connect.mockRejectedValueOnce(new Error('connect failed'))

    await expect(manager.startServer('regular')).rejects.toThrow('connect failed')

    expect(manager.getServerLastError('regular')).toBe('connect failed')
    expect(publishDeepchatEventMock).toHaveBeenCalledTimes(1)
  })

  it('does not publish global errors when a background startup is cancelled', async () => {
    const providerSettings = createProviderSettings({
      regular: {
        command: 'regular-command',
        args: [],
        env: {},
        type: 'stdio'
      }
    })
    const manager = new ServerManager(
      { getLanguage: vi.fn().mockReturnValue('en-US') },
      providerSettings as never,
      { isEnabled: () => false },
      vi.fn() as never,
      {} as never,
      vi.fn(),
      publishDeepchatEventMock
    )
    let rejectConnection: (error: Error) => void = () => {}
    const connectionCompletion = new Promise<void>((_resolve, reject) => {
      rejectConnection = reject
    })
    clientMocks.getConnectionCompletion.mockReturnValue(connectionCompletion)
    clientMocks.connect.mockImplementationOnce(async () => {
      await Promise.resolve()
      clientMocks.getConnectionCompletion.mockReturnValue(null)
      return 'soft-timeout-released'
    })

    await expect(manager.startServer('regular')).resolves.toBe('soft-timeout-released')
    rejectConnection(new McpConnectionCancelledError('regular'))
    await Promise.resolve()

    expect(clientMocks.getConnectionCompletion).toHaveBeenCalledOnce()
    expect(manager.getServerLastError('regular')).toBeUndefined()
    expect(publishDeepchatEventMock).not.toHaveBeenCalled()
  })

  it('retains the background completion when the client clears its internal reference', async () => {
    const providerSettings = createProviderSettings({
      regular: {
        command: 'regular-command',
        args: [],
        env: {},
        type: 'stdio'
      }
    })
    const manager = new ServerManager(
      { getLanguage: vi.fn().mockReturnValue('en-US') },
      providerSettings as never,
      { isEnabled: () => false },
      vi.fn() as never,
      {} as never,
      vi.fn(),
      publishDeepchatEventMock
    )
    let resolveConnection = () => {}
    const connectionCompletion = new Promise<void>((resolve) => {
      resolveConnection = resolve
    })
    const onBackgroundConnected = vi.fn()
    clientMocks.getConnectionCompletion.mockReturnValue(connectionCompletion)
    clientMocks.connect.mockImplementationOnce(async () => {
      await Promise.resolve()
      clientMocks.getConnectionCompletion.mockReturnValue(null)
      return 'soft-timeout-released'
    })

    await expect(manager.startServer('regular', { onBackgroundConnected })).resolves.toBe(
      'soft-timeout-released'
    )
    resolveConnection()
    await connectionCompletion
    await Promise.resolve()

    expect(onBackgroundConnected).toHaveBeenCalledOnce()
  })

  it('propagates supervised startup waiting into the client connection', async () => {
    const providerSettings = createProviderSettings({
      plugin: {
        command: 'plugin-command',
        args: [],
        env: {},
        type: 'stdio',
        ownerPluginId: 'com.deepchat.fixture'
      }
    })
    const manager = new ServerManager(
      { getLanguage: vi.fn().mockReturnValue('en-US') },
      providerSettings as never,
      { isEnabled: () => false },
      vi.fn() as never,
      {} as never,
      vi.fn(),
      publishDeepchatEventMock
    )

    await expect(manager.startServer('plugin', { waitForConnection: true })).resolves.toBe(
      'connected'
    )

    expect(clientMocks.connect).toHaveBeenCalledWith({
      phase: 'startup',
      waitForConnection: true
    })
  })

  it('replaces an inactive client when a runtime supplies a fresh launch override', async () => {
    const persistedEnvironment = { LEGACY_SECRET: 'must-not-be-inherited' }
    const providerSettings = createProviderSettings({
      plugin: {
        command: 'persisted-command',
        args: ['persisted'],
        env: persistedEnvironment,
        type: 'stdio',
        ownerPluginId: 'com.deepchat.fixture'
      }
    })
    const manager = new ServerManager(
      { getLanguage: vi.fn().mockReturnValue('en-US') },
      providerSettings as never,
      { isEnabled: () => false },
      vi.fn() as never,
      {} as never,
      vi.fn(),
      publishDeepchatEventMock
    )
    await manager.startServer('plugin')
    clientMocks.isServerRunning.mockReturnValue(false)
    clientMocks.isActive.mockReturnValue(false)

    await manager.startServer('plugin', {
      configOverride: {
        command: 'fresh-command',
        args: ['fresh'],
        env: { DEEPCHAT_PLUGIN_ID: 'com.deepchat.fixture' }
      },
      waitForConnection: true
    })

    expect(clientMocks.disconnect).toHaveBeenCalledOnce()
    expect(McpClient).toHaveBeenCalledTimes(2)
    expect(vi.mocked(McpClient).mock.calls[1][1]).toMatchObject({
      command: 'fresh-command',
      args: ['fresh'],
      env: { DEEPCHAT_PLUGIN_ID: 'com.deepchat.fixture' }
    })
    expect(vi.mocked(McpClient).mock.calls[1][1]).not.toMatchObject({
      env: persistedEnvironment
    })
  })
})
