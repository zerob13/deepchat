import { describe, expect, it, vi } from 'vitest'

import {
  PluginRuntimeSupervisor,
  type PluginRuntimeFingerprint,
  type PluginRuntimeProcessPort
} from '@/plugin/runtimeSupervisor'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function createProcessPort() {
  const running = new Set<string>()
  const active = new Set<string>()
  const port: PluginRuntimeProcessPort = {
    isReady: vi.fn(() => true),
    isRunning: vi.fn((serverName) => running.has(serverName)),
    isActive: vi.fn((serverName) => active.has(serverName)),
    start: vi.fn(async (serverName) => {
      active.add(serverName)
      running.add(serverName)
    }),
    stop: vi.fn(async (serverName) => {
      running.delete(serverName)
      active.delete(serverName)
    })
  }
  return { port, running, active }
}

function register(
  supervisor: PluginRuntimeSupervisor,
  serverName: string,
  startMode: 'eager' | 'onDemand' = 'eager',
  adapter?: { start: () => Promise<void>; stop: () => Promise<void> },
  launchGuard?: { verify: () => Promise<PluginRuntimeFingerprint> }
) {
  supervisor.registerServer({
    pluginId: 'com.deepchat.plugins.fixture',
    serverName,
    runtimeId: 'fixture-runtime',
    startMode,
    surfaces: startMode === 'onDemand' ? ['tools'] : ['tools', 'prompts', 'resources'],
    toolCatalogPath: startMode === 'onDemand' ? '/fixture/tools.json' : undefined,
    toolCatalog:
      startMode === 'onDemand'
        ? {
            version: '1.0.0',
            tools: [
              {
                name: 'fixture_tool',
                description: 'Fixture tool',
                inputSchema: { type: 'object', properties: {} }
              }
            ]
          }
        : undefined,
    adapter,
    launchGuard
  })
}

describe('PluginRuntimeSupervisor', () => {
  it('coalesces concurrent starts and applies one adapter launch', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port, running } = createProcessPort()
    const launch = deferred<void>()
    const adapter = {
      start: vi.fn(() => launch.promise),
      stop: vi.fn().mockResolvedValue(undefined)
    }
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture', 'onDemand', adapter)

    const first = supervisor.ensureRunning('fixture', 'tool')
    const second = supervisor.ensureRunning('fixture', 'tool')
    launch.resolve()
    await Promise.all([first, second])

    expect(adapter.start).toHaveBeenCalledTimes(1)
    expect(port.start).toHaveBeenCalledTimes(1)
    expect(running.has('fixture')).toBe(true)
    expect(supervisor.getState('fixture')).toEqual({ state: 'running', lastError: undefined })
  })

  it('verifies both adapter and proxy spawns against one immutable fingerprint', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    const adapter = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined)
    }
    const fingerprint = {
      value: 'same-runtime',
      pluginId: 'com.deepchat.plugins.fixture',
      runtimeId: 'fixture-runtime',
      target: 'linux/x64',
      binarySha256: 'a'.repeat(64)
    }
    const launchGuard = {
      verify: vi.fn().mockResolvedValue(fingerprint)
    }
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture', 'onDemand', adapter, launchGuard)

    await supervisor.ensureRunning('fixture', 'tool')

    expect(launchGuard.verify).toHaveBeenCalledTimes(2)
    expect(adapter.start).toHaveBeenCalledTimes(1)
    expect(port.start).toHaveBeenCalledTimes(1)
    expect(launchGuard.verify.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.start.mock.invocationCallOrder[0]
    )
    expect(launchGuard.verify.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(port.start).mock.invocationCallOrder[0]
    )
  })

  it('runs one integrity check for a server with only one process spawn', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    const launchGuard = {
      verify: vi.fn().mockResolvedValue({
        value: 'single-runtime',
        pluginId: 'com.deepchat.plugins.fixture',
        runtimeId: 'fixture-runtime',
        target: 'linux/x64',
        binarySha256: 'a'.repeat(64)
      })
    }
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture', 'onDemand', undefined, launchGuard)

    await supervisor.ensureRunning('fixture', 'tool')

    expect(launchGuard.verify).toHaveBeenCalledOnce()
    expect(port.start).toHaveBeenCalledOnce()
  })

  it('stops the adapter when launch artifacts change before the proxy spawn', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    const adapter = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined)
    }
    const launchGuard = {
      verify: vi
        .fn()
        .mockResolvedValueOnce({
          value: 'first',
          pluginId: 'com.deepchat.plugins.fixture',
          runtimeId: 'fixture-runtime',
          target: 'linux/x64',
          binarySha256: 'a'.repeat(64)
        })
        .mockResolvedValueOnce({
          value: 'second',
          pluginId: 'com.deepchat.plugins.fixture',
          runtimeId: 'fixture-runtime',
          target: 'linux/x64',
          binarySha256: 'b'.repeat(64)
        })
    }
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture', 'onDemand', adapter, launchGuard)

    await expect(supervisor.ensureRunning('fixture', 'tool')).rejects.toThrow(
      'changed between launch checks'
    )

    expect(port.start).not.toHaveBeenCalled()
    expect(adapter.stop).toHaveBeenCalledOnce()
    expect(supervisor.getState('fixture')).toMatchObject({ state: 'error' })
  })

  it('rejects generic starts for on-demand servers without touching the process', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture', 'onDemand')

    await expect(supervisor.requestExternalStart('fixture')).rejects.toThrow(
      'use a plugin runtime test or invoke one of its tools'
    )
    expect(port.start).not.toHaveBeenCalled()
  })

  it('exposes only committed on-demand catalogs and rejects missing discovery contracts', () => {
    const supervisor = new PluginRuntimeSupervisor()

    expect(() =>
      supervisor.registerServer({
        pluginId: 'com.deepchat.plugins.fixture',
        serverName: 'missing-catalog',
        startMode: 'onDemand',
        surfaces: ['tools']
      })
    ).toThrow('requires a tools-only static catalog')

    supervisor.registerServer(
      {
        pluginId: 'com.deepchat.plugins.fixture',
        serverName: 'catalog-server',
        displayName: 'Catalog Server',
        startMode: 'onDemand',
        surfaces: ['tools'],
        toolCatalogPath: '/fixture/tools.json',
        toolCatalog: {
          version: '1.0.0',
          tools: [
            {
              name: 'fixture_tool',
              description: 'Fixture tool',
              inputSchema: { type: 'object', properties: {} }
            }
          ]
        }
      },
      { ready: false }
    )

    expect(supervisor.getAvailableToolCatalogs()).toEqual([])
    supervisor.commitPluginRegistration('com.deepchat.plugins.fixture')
    expect(supervisor.getAvailableToolCatalogs()).toEqual([
      expect.objectContaining({
        serverName: 'catalog-server',
        displayName: 'Catalog Server'
      })
    ])
  })

  it('gates staged registrations without exposing them before commit', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    supervisor.attachProcessPort(port)
    supervisor.registerServer(
      {
        pluginId: 'com.deepchat.plugins.fixture',
        serverName: 'fixture',
        startMode: 'eager',
        surfaces: ['tools']
      },
      { ready: false }
    )

    expect(supervisor.ownsServer('fixture')).toBe(true)
    expect(supervisor.isServerAvailable('fixture')).toBe(false)
    expect(supervisor.getRegistration('fixture')).toBeUndefined()
    await expect(supervisor.ensureRunning('fixture', 'reconcile')).rejects.toThrow(
      'registration is not ready'
    )

    supervisor.commitPluginRegistration('com.deepchat.plugins.fixture')
    expect(supervisor.isServerAvailable('fixture')).toBe(true)
    expect(supervisor.getRegistration('fixture')).toMatchObject({ serverName: 'fixture' })
    await expect(supervisor.ensureRunning('fixture', 'reconcile')).resolves.toBeUndefined()
  })

  it('reconciles eager servers but leaves on-demand servers stopped', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    supervisor.attachProcessPort(port)
    register(supervisor, 'eager-server', 'eager')
    register(supervisor, 'lazy-server', 'onDemand')

    await supervisor.reconcileAll()

    expect(port.start).toHaveBeenCalledTimes(1)
    expect(port.start).toHaveBeenCalledWith('eager-server', undefined)
  })

  it('reconciles independent eager servers concurrently', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port, running, active } = createProcessPort()
    const firstStart = deferred<void>()
    vi.mocked(port.start).mockImplementation(async (serverName) => {
      active.add(serverName)
      if (serverName === 'first') {
        await firstStart.promise
      }
      running.add(serverName)
    })
    supervisor.attachProcessPort(port)
    register(supervisor, 'first')
    register(supervisor, 'second')

    const reconcile = supervisor.reconcileAll()
    await vi.waitFor(() => expect(port.start).toHaveBeenCalledTimes(2))
    firstStart.resolve()
    await reconcile

    expect(running).toEqual(new Set(['first', 'second']))
  })

  it('retries an inactive eager server after authentication completes', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    supervisor.attachProcessPort(port)
    register(supervisor, 'eager-server')
    register(supervisor, 'lazy-server', 'onDemand')

    await expect(supervisor.restartIfRunning('eager-server', 'authentication')).resolves.toBe(true)
    await expect(supervisor.restartIfRunning('lazy-server', 'authentication')).resolves.toBe(true)

    expect(port.start).toHaveBeenCalledTimes(1)
    expect(port.start).toHaveBeenCalledWith('eager-server', undefined)
  })

  it('waits for an in-flight start before performing a symmetric stop', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port, running, active } = createProcessPort()
    const processStart = deferred<void>()
    vi.mocked(port.start).mockImplementation(async (serverName) => {
      active.add(serverName)
      await processStart.promise
      running.add(serverName)
    })
    const adapter = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined)
    }
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture', 'eager', adapter)

    const start = supervisor.ensureRunning('fixture', 'reconcile')
    const stop = supervisor.requestExternalStop('fixture')
    expect(port.stop).not.toHaveBeenCalled()

    processStart.resolve()
    await Promise.all([start, stop])

    expect(port.stop).toHaveBeenCalledTimes(1)
    expect(adapter.stop).toHaveBeenCalledTimes(1)
    expect(supervisor.getState('fixture')).toEqual({ state: 'stopped', lastError: undefined })
  })

  it('cleans up both MCP and adapter state after a failed start', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port, active } = createProcessPort()
    vi.mocked(port.start).mockImplementation(async (serverName) => {
      active.add(serverName)
      throw new Error('connect failed')
    })
    const adapter = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined)
    }
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture', 'eager', adapter)

    await expect(supervisor.ensureRunning('fixture', 'reconcile')).rejects.toThrow('connect failed')

    expect(port.stop).toHaveBeenCalledWith('fixture', 'normal')
    expect(adapter.stop).toHaveBeenCalledTimes(1)
    expect(supervisor.getState('fixture')).toEqual({
      state: 'error',
      lastError: 'connect failed'
    })
  })

  it('rejects ownership collisions and removes registrations after plugin disable', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture')

    expect(() =>
      supervisor.registerServer({
        pluginId: 'com.deepchat.plugins.other',
        serverName: 'fixture',
        startMode: 'eager',
        surfaces: ['tools']
      })
    ).toThrow('already registered')

    await supervisor.unregisterPlugin('com.deepchat.plugins.fixture')

    expect(supervisor.ownsServer('fixture')).toBe(false)
    await expect(supervisor.ensureRunning('fixture', 'tool')).rejects.toThrow('is not registered')
  })

  it('keeps a retired ownership gate when disable cleanup fails', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port, running, active } = createProcessPort()
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture')
    await supervisor.ensureRunning('fixture', 'reconcile')
    vi.mocked(port.stop).mockRejectedValueOnce(new Error('stop failed'))

    await expect(supervisor.unregisterPlugin('com.deepchat.plugins.fixture')).rejects.toThrow(
      'Failed to stop plugin runtime servers'
    )

    expect(supervisor.ownsServer('fixture')).toBe(true)
    expect(supervisor.isServerAvailable('fixture')).toBe(false)
    expect(supervisor.getRegistration('fixture')).toBeUndefined()
    await expect(supervisor.ensureRunning('fixture', 'tool')).rejects.toThrow('is being disabled')
    expect(running.has('fixture')).toBe(true)
    expect(active.has('fixture')).toBe(true)

    await supervisor.unregisterPlugin('com.deepchat.plugins.fixture')
    expect(supervisor.ownsServer('fixture')).toBe(false)
  })

  it('waits for an active stop before deciding whether another start is needed', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port, running, active } = createProcessPort()
    const processStop = deferred<void>()
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture')
    await supervisor.ensureRunning('fixture', 'reconcile')
    vi.mocked(port.stop).mockImplementationOnce(async (serverName) => {
      await processStop.promise
      running.delete(serverName)
      active.delete(serverName)
    })

    const stop = supervisor.requestExternalStop('fixture')
    const restart = supervisor.ensureRunning('fixture', 'configuration')
    await Promise.resolve()
    expect(port.start).toHaveBeenCalledTimes(1)

    processStop.resolve()
    await Promise.all([stop, restart])

    expect(port.start).toHaveBeenCalledTimes(2)
    expect(supervisor.getState('fixture')).toEqual({ state: 'running', lastError: undefined })
  })

  it('fails closed when the process port returns without a running client', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port } = createProcessPort()
    vi.mocked(port.start).mockResolvedValue(undefined)
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture')

    await expect(supervisor.ensureRunning('fixture', 'reconcile')).rejects.toThrow(
      'did not reach running state'
    )
    expect(supervisor.getState('fixture')).toEqual({
      state: 'error',
      lastError: 'Plugin runtime server "fixture" did not reach running state'
    })
  })

  it('refuses to stack a new launch over an incomplete active transition', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port, active } = createProcessPort()
    active.add('fixture')
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture')

    await expect(supervisor.ensureRunning('fixture', 'runtime-retry')).rejects.toThrow(
      'active process from an incomplete transition'
    )
    expect(port.start).not.toHaveBeenCalled()
    expect(supervisor.getState('fixture')).toEqual({
      state: 'error',
      lastError:
        'Plugin runtime server "fixture" still has an active process from an incomplete transition'
    })
  })

  it('blocks new starts and escalates a hanging normal stop during shutdown', async () => {
    const supervisor = new PluginRuntimeSupervisor()
    const { port, running, active } = createProcessPort()
    const normalStop = deferred<void>()
    const adapter = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined)
    }
    supervisor.attachProcessPort(port)
    register(supervisor, 'fixture', 'eager', adapter)
    await supervisor.ensureRunning('fixture', 'reconcile')
    vi.mocked(port.stop).mockImplementation(async (serverName, mode) => {
      if (mode === 'normal') {
        await normalStop.promise
      }
      running.delete(serverName)
      active.delete(serverName)
    })

    const disable = supervisor.requestExternalStop('fixture')
    await vi.waitFor(() => expect(port.stop).toHaveBeenCalledWith('fixture', 'normal'))
    await supervisor.shutdown()

    expect(port.stop).toHaveBeenCalledWith('fixture', 'shutdown')
    expect(adapter.stop).toHaveBeenCalledTimes(1)
    expect(supervisor.isServerAvailable('fixture')).toBe(false)
    await expect(supervisor.ensureRunning('fixture', 'tool')).rejects.toThrow('shutting down')

    normalStop.resolve()
    await disable
  })
})
