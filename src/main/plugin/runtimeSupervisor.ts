import type { MCPServerConfig } from '@shared/types/mcp'
import type { PluginMcpStartMode, PluginMcpSurface } from '@shared/types/plugin'
import type { PluginToolCatalog } from './toolCatalog'

export type PluginRuntimeStartReason =
  | 'reconcile'
  | 'tool'
  | 'runtime-test'
  | 'runtime-retry'
  | 'authentication'
  | 'configuration'
  | 'external'

export type PluginRuntimeLifecycleState =
  | 'registered'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error'

export interface PluginRuntimeAdapterInstance {
  start(
    reason: PluginRuntimeStartReason
  ): Promise<{ configOverride?: Partial<MCPServerConfig> } | void>
  stop(): Promise<void>
}

export type PluginRuntimeFingerprint = {
  value: string
  pluginId: string
  runtimeId: string
  target: string
  binarySha256: string
}

export interface PluginRuntimeLaunchGuard {
  verify(): Promise<PluginRuntimeFingerprint>
}

export interface PluginOwnedServerRegistration {
  pluginId: string
  serverName: string
  displayName?: string
  runtimeId?: string
  startMode: PluginMcpStartMode
  surfaces: PluginMcpSurface[]
  toolCatalogPath?: string
  toolCatalog?: PluginToolCatalog
  adapter?: PluginRuntimeAdapterInstance
  launchGuard?: PluginRuntimeLaunchGuard
}

export interface PluginOwnedToolCatalogRegistration {
  readonly pluginId: string
  readonly serverName: string
  readonly displayName: string
  readonly toolCatalog: PluginToolCatalog
}

export interface PluginRuntimeProcessPort {
  isReady(): boolean
  isRunning(serverName: string): boolean
  isActive(serverName: string): boolean
  start(serverName: string, configOverride?: Partial<MCPServerConfig>): Promise<void>
  stop(serverName: string, mode: 'normal' | 'shutdown'): Promise<void>
}

type RuntimeEntry = {
  registration: PluginOwnedServerRegistration
  state: PluginRuntimeLifecycleState
  ready: boolean
  retiring: boolean
  adapterCleanupRequired: boolean
  lastError?: string
}

export class PluginRuntimeSupervisor {
  private readonly entries = new Map<string, RuntimeEntry>()
  private readonly startPromises = new Map<string, Promise<void>>()
  private readonly stopPromises = new Map<string, Promise<void>>()
  private readonly adapterStopPromises = new Map<string, Promise<void>>()
  private readonly registryListeners = new Set<() => void>()
  private processPort?: PluginRuntimeProcessPort
  private shuttingDown = false

  attachProcessPort(processPort: PluginRuntimeProcessPort): void {
    if (this.processPort && this.processPort !== processPort) {
      throw new Error('Plugin runtime process port is already attached')
    }
    this.processPort = processPort
  }

  subscribeRegistryChanged(listener: () => void): () => void {
    this.registryListeners.add(listener)
    return () => this.registryListeners.delete(listener)
  }

  registerServer(
    registration: PluginOwnedServerRegistration,
    options: { ready?: boolean } = {}
  ): void {
    if (this.shuttingDown) {
      throw new Error('Plugin runtime supervisor is shutting down')
    }
    const serverName = registration.serverName.trim()
    const pluginId = registration.pluginId.trim()
    if (!serverName || !pluginId) {
      throw new Error('Plugin runtime registration requires pluginId and serverName')
    }
    if (
      registration.startMode === 'onDemand' &&
      (registration.surfaces.length !== 1 ||
        registration.surfaces[0] !== 'tools' ||
        !registration.toolCatalog)
    ) {
      throw new Error(
        `On-demand plugin runtime server "${serverName}" requires a tools-only static catalog`
      )
    }

    const existing = this.entries.get(serverName)
    if (existing) {
      const detail =
        existing.registration.pluginId === pluginId
          ? 'already has an active registration'
          : `is already registered by ${existing.registration.pluginId}`
      throw new Error(`Plugin-owned MCP server "${serverName}" ${detail}`)
    }

    this.entries.set(serverName, {
      registration: {
        ...registration,
        pluginId,
        serverName,
        surfaces: [...registration.surfaces]
      },
      state: 'registered',
      ready: options.ready ?? true,
      retiring: false,
      adapterCleanupRequired: false
    })
    this.notifyRegistryChanged()
  }

  ownsServer(serverName: string): boolean {
    return this.entries.has(serverName)
  }

  isServerAvailable(serverName: string): boolean {
    const entry = this.entries.get(serverName)
    return Boolean(entry?.ready && !entry.retiring && !this.shuttingDown)
  }

  getRegistration(serverName: string): PluginOwnedServerRegistration | undefined {
    const entry = this.entries.get(serverName)
    return entry && entry.ready && !entry.retiring && !this.shuttingDown
      ? {
          ...entry.registration,
          surfaces: [...entry.registration.surfaces]
        }
      : undefined
  }

  getOwnerPluginId(serverName: string): string | undefined {
    return this.entries.get(serverName)?.registration.pluginId
  }

  getAvailableToolCatalogs(): PluginOwnedToolCatalogRegistration[] {
    if (this.shuttingDown) {
      return []
    }
    return Array.from(this.entries.values()).flatMap((entry) => {
      const { registration } = entry
      if (
        !entry.ready ||
        entry.retiring ||
        registration.startMode !== 'onDemand' ||
        !registration.toolCatalog
      ) {
        return []
      }
      return [
        {
          pluginId: registration.pluginId,
          serverName: registration.serverName,
          displayName: registration.displayName ?? registration.serverName,
          toolCatalog: registration.toolCatalog
        }
      ]
    })
  }

  commitPluginRegistration(pluginId: string): void {
    let changed = false
    for (const entry of this.entries.values()) {
      if (entry.registration.pluginId === pluginId && !entry.retiring && !entry.ready) {
        entry.ready = true
        changed = true
      }
    }
    if (changed) {
      this.notifyRegistryChanged()
    }
  }

  getState(
    serverName: string
  ): { state: PluginRuntimeLifecycleState; lastError?: string } | undefined {
    const entry = this.entries.get(serverName)
    return entry ? { state: entry.state, lastError: entry.lastError } : undefined
  }

  async reconcileAll(): Promise<void> {
    if (!this.processPort?.isReady()) {
      return
    }
    const registrations = Array.from(this.entries.values())
      .filter((entry) => entry.ready && !entry.retiring)
      .map((entry) => entry.registration)
      .filter((registration) => registration.startMode === 'eager')
    await this.reconcileRegistrations(registrations, 'Failed to reconcile eager plugin runtimes')
  }

  async reconcilePlugin(pluginId: string): Promise<void> {
    if (!this.processPort?.isReady()) {
      return
    }
    const eagerServers = Array.from(this.entries.values())
      .filter((entry) => entry.ready && !entry.retiring)
      .map((entry) => entry.registration)
      .filter(
        (registration) => registration.pluginId === pluginId && registration.startMode === 'eager'
      )
    await this.reconcileRegistrations(
      eagerServers,
      `Failed to reconcile plugin runtimes for ${pluginId}`
    )
  }

  async ensureRunning(serverName: string, reason: PluginRuntimeStartReason): Promise<void> {
    let entry = this.getStartableEntry(serverName)
    const processPort = this.getProcessPort()
    if (!processPort.isReady()) {
      throw new Error(`Plugin runtime server "${serverName}" cannot start before MCP is ready`)
    }

    const stopping = this.stopPromises.get(serverName)
    if (stopping) {
      await stopping
      entry = this.getStartableEntry(serverName)
    }
    const existingStart = this.startPromises.get(serverName)
    if (existingStart) {
      return await existingStart
    }
    if (processPort.isRunning(serverName)) {
      entry.state = 'running'
      entry.lastError = undefined
      return
    }
    if (processPort.isActive(serverName)) {
      const error = new Error(
        `Plugin runtime server "${serverName}" still has an active process from an incomplete transition`
      )
      entry.state = 'error'
      entry.lastError = error.message
      throw error
    }

    const startPromise = this.startEntry(entry, reason)
    this.startPromises.set(serverName, startPromise)
    try {
      await startPromise
    } finally {
      if (this.startPromises.get(serverName) === startPromise) {
        this.startPromises.delete(serverName)
      }
    }
  }

  async requestExternalStart(serverName: string): Promise<void> {
    const registration = this.getStartableEntry(serverName).registration
    if (registration.startMode === 'onDemand') {
      throw new Error(
        `Plugin runtime server "${serverName}" is on-demand; use a plugin runtime test or invoke one of its tools`
      )
    }
    await this.ensureRunning(serverName, 'external')
  }

  async requestExternalStop(serverName: string): Promise<void> {
    if (!this.entries.has(serverName)) {
      throw new Error(`Plugin runtime server "${serverName}" is not registered`)
    }
    await this.stopServer(serverName)
  }

  async restartIfRunning(
    serverName: string,
    reason: Extract<PluginRuntimeStartReason, 'authentication' | 'configuration'>
  ): Promise<boolean> {
    const processPort = this.processPort
    const entry = this.entries.get(serverName)
    if (!entry) {
      return false
    }
    if (entry.retiring) {
      return true
    }
    if (
      !processPort ||
      (!processPort.isActive(serverName) && !this.startPromises.has(serverName))
    ) {
      if (entry.registration.startMode === 'eager') {
        await this.ensureRunning(serverName, reason)
      }
      return true
    }
    await this.stopServer(serverName)
    await this.ensureRunning(serverName, reason)
    return true
  }

  async unregisterPlugin(pluginId: string): Promise<void> {
    const entries = Array.from(this.entries.values()).filter(
      (entry) => entry.registration.pluginId === pluginId
    )
    for (const entry of entries) {
      entry.retiring = true
    }
    if (entries.length > 0) {
      this.notifyRegistryChanged()
    }

    const errors: unknown[] = []
    for (const entry of entries) {
      const { serverName } = entry.registration
      try {
        await this.stopServer(serverName)
        if (this.entries.get(serverName) === entry) {
          this.entries.delete(serverName)
        }
      } catch (error) {
        errors.push(error)
      }
    }
    if (entries.length > 0) {
      this.notifyRegistryChanged()
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to stop plugin runtime servers for ${pluginId}`)
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shuttingDown) {
      this.shuttingDown = true
      if (this.entries.size > 0) {
        this.notifyRegistryChanged()
      }
    }
    const serverNames = Array.from(this.entries.keys())
    const results = await Promise.allSettled(
      serverNames.map((serverName) => this.stopServer(serverName, 'shutdown'))
    )
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to stop all plugin runtime servers')
    }
  }

  private async startEntry(entry: RuntimeEntry, reason: PluginRuntimeStartReason): Promise<void> {
    const processPort = this.getProcessPort()
    const { registration } = entry
    entry.state = 'starting'
    entry.lastError = undefined

    try {
      const initialFingerprint = registration.adapter
        ? await registration.launchGuard?.verify()
        : undefined
      if (registration.adapter) {
        entry.adapterCleanupRequired = true
      }
      const launch = await registration.adapter?.start(reason)
      if (entry.retiring || this.shuttingDown) {
        throw new Error(
          `Plugin runtime server "${registration.serverName}" was stopped during startup`
        )
      }
      const proxyFingerprint = await registration.launchGuard?.verify()
      if (
        initialFingerprint &&
        proxyFingerprint &&
        initialFingerprint.value !== proxyFingerprint.value
      ) {
        throw new Error(
          `Plugin runtime server "${registration.serverName}" changed between launch checks`
        )
      }
      await processPort.start(registration.serverName, launch?.configOverride)
      if (!processPort.isRunning(registration.serverName)) {
        throw new Error(
          `Plugin runtime server "${registration.serverName}" did not reach running state`
        )
      }
      entry.state = 'running'
    } catch (error) {
      const cleanupErrors: unknown[] = []
      if (processPort.isActive(registration.serverName)) {
        try {
          await processPort.stop(registration.serverName, 'normal')
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (registration.adapter) {
        try {
          await this.stopAdapter(entry)
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      entry.state = 'error'
      if (cleanupErrors.length > 0) {
        const aggregateError = new AggregateError(
          [error, ...cleanupErrors],
          `Plugin runtime server "${registration.serverName}" failed to start and cleanup was incomplete`
        )
        entry.lastError = aggregateError.message
        throw aggregateError
      }
      entry.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async stopServer(
    serverName: string,
    mode: 'normal' | 'shutdown' = 'normal'
  ): Promise<void> {
    const entry = this.entries.get(serverName)
    if (!entry) {
      return
    }
    const existingStop = this.stopPromises.get(serverName)
    if (existingStop) {
      if (mode === 'shutdown') {
        await this.escalateStopForShutdown(entry, existingStop)
        return
      }
      return await existingStop
    }

    const stopPromise = this.stopEntry(entry, mode)
    this.stopPromises.set(serverName, stopPromise)
    try {
      await stopPromise
    } finally {
      if (this.stopPromises.get(serverName) === stopPromise) {
        this.stopPromises.delete(serverName)
      }
    }
  }

  private async stopEntry(entry: RuntimeEntry, mode: 'normal' | 'shutdown'): Promise<void> {
    const { registration } = entry
    const startPromise = this.startPromises.get(registration.serverName)
    if (startPromise) {
      await startPromise.catch(() => undefined)
    }

    const processPort = this.processPort
    const errors: unknown[] = []
    entry.state = 'stopping'
    if (processPort?.isActive(registration.serverName)) {
      try {
        await processPort.stop(registration.serverName, mode)
      } catch (error) {
        errors.push(error)
      }
    }
    if (registration.adapter && entry.adapterCleanupRequired) {
      try {
        await this.stopAdapter(entry)
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) {
      entry.state = 'error'
      entry.lastError = errors.map((error) => String(error)).join('; ')
      throw new AggregateError(
        errors,
        `Plugin runtime server "${registration.serverName}" failed to stop cleanly`
      )
    }
    entry.state = 'stopped'
    entry.lastError = undefined
  }

  private getProcessPort(): PluginRuntimeProcessPort {
    if (!this.processPort) {
      throw new Error('Plugin runtime process port is not attached')
    }
    return this.processPort
  }

  private getStartableEntry(serverName: string): RuntimeEntry {
    if (this.shuttingDown) {
      throw new Error('Plugin runtime supervisor is shutting down')
    }
    const entry = this.entries.get(serverName)
    if (!entry) {
      throw new Error(`Plugin runtime server "${serverName}" is not registered`)
    }
    if (entry.retiring) {
      throw new Error(`Plugin runtime server "${serverName}" is being disabled`)
    }
    if (!entry.ready) {
      throw new Error(`Plugin runtime server "${serverName}" registration is not ready`)
    }
    return entry
  }

  private async escalateStopForShutdown(
    entry: RuntimeEntry,
    existingStop: Promise<void>
  ): Promise<void> {
    const processPort = this.processPort
    const { serverName } = entry.registration
    if (!processPort?.isActive(serverName)) {
      await existingStop
      return
    }

    const winner = await Promise.race([
      existingStop.then(() => 'existing' as const),
      processPort.stop(serverName, 'shutdown').then(() => 'escalated' as const)
    ])
    if (winner === 'existing') {
      return
    }

    await this.stopAdapter(entry)
    entry.state = 'stopped'
    entry.lastError = undefined
  }

  private async stopAdapter(entry: RuntimeEntry): Promise<void> {
    const { adapter, serverName } = entry.registration
    if (!adapter || !entry.adapterCleanupRequired) {
      return
    }
    const existingStop = this.adapterStopPromises.get(serverName)
    if (existingStop) {
      return await existingStop
    }

    const stopPromise = (async () => {
      await adapter.stop()
      entry.adapterCleanupRequired = false
    })()
    this.adapterStopPromises.set(serverName, stopPromise)
    try {
      await stopPromise
    } finally {
      if (this.adapterStopPromises.get(serverName) === stopPromise) {
        this.adapterStopPromises.delete(serverName)
      }
    }
  }

  private async reconcileRegistrations(
    registrations: PluginOwnedServerRegistration[],
    aggregateMessage: string
  ): Promise<void> {
    const results = await Promise.allSettled(
      registrations.map((registration) => this.ensureRunning(registration.serverName, 'reconcile'))
    )
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length > 0) {
      throw new AggregateError(errors, aggregateMessage)
    }
  }

  private notifyRegistryChanged(): void {
    for (const listener of this.registryListeners) {
      try {
        listener()
      } catch (error) {
        console.error('[PluginRuntimeSupervisor] Registry listener failed:', error)
      }
    }
  }
}
