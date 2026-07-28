import { terminateProcessTree } from '@/agent/shared/process/processTree'
import { createMinimalProcessEnvironment } from '@/mcp/processEnvironment'
import type { MCPServerConfig } from '@shared/types/mcp'
import type { CuaEmbeddedRuntimeContract } from '@shared/types/plugin'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  PluginRuntimeAdapterInstance,
  PluginRuntimeLaunchContext,
  PluginRuntimeSafetyHooks,
  PluginRuntimeStartReason
} from './runtimeSupervisor'

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000
const HANDSHAKE_ATTEMPT_TIMEOUT_MS = 500
const MAX_HANDSHAKE_BYTES = 64 * 1024
const UNIX_SOCKET_PATH_LIMIT = 104
const CUA_ENDPOINT_NAME_PATTERN = /^deepchat-cua-\d+-[a-f0-9]{12}\.sock$/i
const CUA_PIPE_NAME_PATTERN = /^\\\\\.\\pipe\\deepchat-cua-\d+-[a-f0-9]{12}$/i

export interface CuaDaemonMetadata {
  driver_version: string
  contract_version: string
  tools_list_schema_version: string
  capability_version: string
  mcp_protocol_version: string
  pid: number
  embedded: boolean
  host_bundle_id?: string
}

type EndpointIdentity = {
  device: bigint
  inode: bigint
}

type RunningDaemon = {
  child: ChildProcess
  endpoint: string
  endpointIdentity?: EndpointIdentity
  stderr: () => string
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess

type AdapterDependencies = {
  spawnProcess: SpawnProcess
  requestMetadata: (endpoint: string, timeoutMs: number) => Promise<CuaDaemonMetadata>
  createEndpoint: (platform: NodeJS.Platform) => string
  captureEndpointIdentity: (
    endpoint: string,
    platform: NodeJS.Platform
  ) => EndpointIdentity | undefined
  cleanupEndpoint: (
    endpoint: string,
    platform: NodeJS.Platform,
    identity?: EndpointIdentity
  ) => void
  terminateProcess: typeof terminateProcessTree
  delay: (milliseconds: number) => Promise<unknown>
}

export type CuaEmbeddedRuntimeAdapterOptions = {
  binaryPath: string
  platform: NodeJS.Platform
  contract: CuaEmbeddedRuntimeContract
  environment: Record<string, string>
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null

const endpointIdentity = (endpoint: string): EndpointIdentity => {
  const stat = fs.lstatSync(endpoint, { bigint: true })
  if (!stat.isSocket()) {
    throw new Error(`CUA embedded endpoint is not a Unix socket: ${endpoint}`)
  }
  if ((stat.mode & 0o777n) !== 0o600n) {
    throw new Error(`CUA embedded endpoint is not private (expected mode 0600): ${endpoint}`)
  }
  return { device: stat.dev, inode: stat.ino }
}

const captureEndpointIdentity = (
  endpoint: string,
  platform: NodeJS.Platform
): EndpointIdentity | undefined => (platform === 'win32' ? undefined : endpointIdentity(endpoint))

const cleanupEndpoint = (
  endpoint: string,
  platform: NodeJS.Platform,
  identity?: EndpointIdentity
): void => {
  if (platform === 'win32' || !identity) {
    return
  }
  try {
    const current = fs.lstatSync(endpoint, { bigint: true })
    if (current.isSocket() && current.dev === identity.device && current.ino === identity.inode) {
      fs.rmSync(endpoint, { force: true })
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw error
    }
  }
}

export class CuaDaemonHandshakeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CuaDaemonHandshakeUnavailableError'
  }
}

export class CuaDaemonCompatibilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CuaDaemonCompatibilityError'
  }
}

export const createCuaEmbeddedEndpoint = (
  platform: NodeJS.Platform,
  generation = randomUUID(),
  pid = process.pid,
  temporaryDirectory = os.tmpdir()
): string => {
  const suffix = generation.replaceAll('-', '').slice(0, 12)
  if (!/^[a-f0-9]{12}$/i.test(suffix)) {
    throw new Error('CUA embedded endpoint generation must contain at least 12 hex characters')
  }
  if (platform === 'win32') {
    return `\\\\.\\pipe\\deepchat-cua-${pid}-${suffix}`
  }

  const filename = `deepchat-cua-${pid}-${suffix}.sock`
  const preferred = path.resolve(temporaryDirectory, filename)
  const endpoint =
    Buffer.byteLength(preferred) < UNIX_SOCKET_PATH_LIMIT ? preferred : path.join('/tmp', filename)
  if (!path.isAbsolute(endpoint) || Buffer.byteLength(endpoint) >= UNIX_SOCKET_PATH_LIMIT) {
    throw new Error(`CUA embedded Unix socket path exceeds ${UNIX_SOCKET_PATH_LIMIT - 1} bytes`)
  }
  return endpoint
}

export const requestCuaDaemonMetadata = async (
  endpoint: string,
  timeoutMs = HANDSHAKE_ATTEMPT_TIMEOUT_MS
): Promise<CuaDaemonMetadata> =>
  await new Promise<CuaDaemonMetadata>((resolve, reject) => {
    const socket = net.createConnection(endpoint)
    const chunks: Buffer[] = []
    let byteLength = 0
    let settled = false

    const settle = (error?: Error, metadata?: CuaDaemonMetadata) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      if (error) {
        reject(error)
      } else {
        resolve(metadata as CuaDaemonMetadata)
      }
    }

    const timeout = setTimeout(
      () =>
        settle(
          new CuaDaemonHandshakeUnavailableError(
            `Timed out connecting to CUA embedded endpoint ${endpoint}`
          )
        ),
      timeoutMs
    )

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ method: 'metadata' })}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      byteLength += chunk.length
      if (byteLength > MAX_HANDSHAKE_BYTES) {
        settle(new Error('CUA daemon metadata response exceeded 64 KiB'))
        return
      }
      const buffer = Buffer.concat(chunks, byteLength)
      const newline = buffer.indexOf(0x0a)
      if (newline === -1) {
        return
      }
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as unknown
        if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
          throw new Error('CUA daemon metadata response has an invalid envelope')
        }
        settle(undefined, response.result as unknown as CuaDaemonMetadata)
      } catch (error) {
        settle(
          error instanceof Error
            ? error
            : new Error(`Invalid CUA daemon metadata response: ${String(error)}`)
        )
      }
    })
    socket.once('error', (error) => {
      settle(
        new CuaDaemonHandshakeUnavailableError(
          `Unable to connect to CUA embedded endpoint ${endpoint}`,
          { cause: error }
        )
      )
    })
    socket.once('close', () => {
      if (!settled) {
        settle(
          new CuaDaemonHandshakeUnavailableError(
            `CUA embedded endpoint ${endpoint} closed before metadata was returned`
          )
        )
      }
    })
  })

export const validateCuaDaemonMetadata = (
  metadata: CuaDaemonMetadata,
  expectedPid: number,
  contract: CuaEmbeddedRuntimeContract
): void => {
  const expected: Array<[keyof CuaDaemonMetadata, unknown]> = [
    ['driver_version', contract.driverVersion],
    ['contract_version', contract.contractVersion],
    ['tools_list_schema_version', contract.toolsListSchemaVersion],
    ['capability_version', contract.capabilityVersion],
    ['mcp_protocol_version', contract.mcpProtocolVersion],
    ['pid', expectedPid],
    ['embedded', true],
    ['host_bundle_id', contract.hostBundleId]
  ]
  for (const [field, expectedValue] of expected) {
    if (metadata[field] !== expectedValue) {
      throw new CuaDaemonCompatibilityError(
        `CUA daemon metadata ${field} mismatch: expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(metadata[field])}`
      )
    }
  }
}

const defaultDependencies: AdapterDependencies = {
  spawnProcess: (command, args, options) => spawn(command, args, options),
  requestMetadata: requestCuaDaemonMetadata,
  createEndpoint: createCuaEmbeddedEndpoint,
  captureEndpointIdentity,
  cleanupEndpoint,
  terminateProcess: terminateProcessTree,
  delay: async (milliseconds) => await delay(milliseconds)
}

export class CuaEmbeddedRuntimeAdapter implements PluginRuntimeAdapterInstance {
  private readonly dependencies: AdapterDependencies
  private readonly startupTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private running?: RunningDaemon
  private stopPromise?: Promise<void>

  constructor(
    private readonly options: CuaEmbeddedRuntimeAdapterOptions,
    dependencies: Partial<AdapterDependencies> = {}
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies }
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  }

  async start(
    _reason: PluginRuntimeStartReason,
    safetyHooks?: PluginRuntimeSafetyHooks
  ): Promise<{ configOverride: Partial<MCPServerConfig> }> {
    if (this.stopPromise) {
      await this.stopPromise
    }
    if (this.running && !hasExited(this.running.child)) {
      try {
        await this.verifyRunningDaemon(this.running)
        this.persistLaunchContext(safetyHooks, this.running.endpoint, this.running.endpointIdentity)
        return this.proxyConfiguration(this.running.endpoint)
      } catch {
        await this.stop()
      }
    } else if (this.running) {
      this.dependencies.cleanupEndpoint(
        this.running.endpoint,
        this.options.platform,
        this.running.endpointIdentity
      )
      this.running = undefined
    }

    const endpoint = this.dependencies.createEndpoint(this.options.platform)
    this.assertEndpointAvailable(endpoint)
    this.persistLaunchContext(safetyHooks, endpoint)
    let endpointIdentity: EndpointIdentity | undefined
    let endpointIdentityCaptureAttempted = false
    const stderrChunks: Buffer[] = []
    let stderrLength = 0
    let childError: Error | undefined
    const child = this.dependencies.spawnProcess(
      this.options.binaryPath,
      [
        'serve',
        '--embedded',
        '--parent-liveness-stdio',
        '--no-permissions-gate',
        '--socket',
        endpoint,
        '--host-bundle-id',
        this.options.contract.hostBundleId,
        '--permission-mode',
        'standard'
      ],
      {
        env: {
          ...createMinimalProcessEnvironment(process.env, this.options.platform),
          ...this.options.environment
        },
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true
      }
    )
    child.on('error', (error) => {
      childError = error
    })
    child.stdin?.on('error', (error) => {
      childError ??= error
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stderrChunks.push(bytes)
      stderrLength += bytes.length
      while (stderrLength > 16 * 1024 && stderrChunks.length > 1) {
        stderrLength -= stderrChunks.shift()?.length ?? 0
      }
    })
    const stderr = () =>
      Buffer.concat(stderrChunks)
        .subarray(-16 * 1024)
        .toString('utf8')
        .trim()

    try {
      await this.waitForSpawn(child)
      if (!child.pid) {
        throw childError ?? new Error('CUA daemon process did not report a pid')
      }
      const metadata = await this.waitForReady(child, endpoint, () => childError, stderr)
      endpointIdentityCaptureAttempted = true
      endpointIdentity = this.dependencies.captureEndpointIdentity(endpoint, this.options.platform)
      this.persistLaunchContext(safetyHooks, endpoint, endpointIdentity)
      validateCuaDaemonMetadata(metadata, child.pid, this.options.contract)
      if (hasExited(child)) {
        throw new Error(
          `CUA daemon exited immediately after readiness${this.stderrSuffix(stderr())}`
        )
      }
      this.running = { child, endpoint, endpointIdentity, stderr }
      return this.proxyConfiguration(endpoint)
    } catch (error) {
      const cleanupErrors: unknown[] = []
      if (this.options.platform !== 'win32' && !endpointIdentityCaptureAttempted) {
        try {
          endpointIdentity = this.dependencies.captureEndpointIdentity(
            endpoint,
            this.options.platform
          )
        } catch (captureError) {
          if ((captureError as NodeJS.ErrnoException).code !== 'ENOENT') {
            cleanupErrors.push(captureError)
          }
        }
      }
      let terminated = false
      try {
        terminated = await this.terminateChild(child)
        if (!terminated) {
          cleanupErrors.push(new Error('CUA daemon could not be terminated after startup failure'))
        }
      } catch (terminationError) {
        cleanupErrors.push(terminationError)
      }
      if (terminated && endpointIdentity) {
        try {
          this.dependencies.cleanupEndpoint(endpoint, this.options.platform, endpointIdentity)
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'CUA embedded daemon startup failed and cleanup was incomplete'
        )
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return await this.stopPromise
    }
    const running = this.running
    if (!running) {
      return
    }

    const stopPromise = (async () => {
      const terminated = await this.terminateChild(running.child)
      if (!terminated) {
        throw new Error(
          `CUA embedded daemon did not terminate${this.stderrSuffix(running.stderr())}`
        )
      }
      this.dependencies.cleanupEndpoint(
        running.endpoint,
        this.options.platform,
        running.endpointIdentity
      )
      if (this.running === running) {
        this.running = undefined
      }
    })()
    this.stopPromise = stopPromise
    try {
      await stopPromise
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined
      }
    }
  }

  async recoverStaleLaunch(context: PluginRuntimeLaunchContext): Promise<void> {
    const endpoint = context.endpoint
    this.assertManagedEndpoint(endpoint)
    if (this.options.platform === 'win32') {
      return
    }

    const device = context.endpointDevice
    const inode = context.endpointInode
    if (device === undefined && inode === undefined) {
      return
    }
    if (!/^\d+$/.test(device ?? '') || !/^\d+$/.test(inode ?? '')) {
      throw new Error('CUA stale endpoint identity is invalid')
    }
    this.dependencies.cleanupEndpoint(endpoint, this.options.platform, {
      device: BigInt(device),
      inode: BigInt(inode)
    })
  }

  private async verifyRunningDaemon(running: RunningDaemon): Promise<void> {
    const pid = running.child.pid
    if (!pid) {
      throw new Error('CUA daemon process has no pid')
    }
    const metadata = await this.dependencies.requestMetadata(
      running.endpoint,
      HANDSHAKE_ATTEMPT_TIMEOUT_MS
    )
    validateCuaDaemonMetadata(metadata, pid, this.options.contract)
  }

  private async waitForReady(
    child: ChildProcess,
    endpoint: string,
    getChildError: () => Error | undefined,
    stderr: () => string
  ): Promise<CuaDaemonMetadata> {
    const deadline = Date.now() + this.startupTimeoutMs
    let lastUnavailable: Error | undefined
    while (Date.now() < deadline) {
      const childError = getChildError()
      if (childError) {
        throw childError
      }
      if (hasExited(child)) {
        throw new Error(
          `CUA daemon exited before readiness (code=${child.exitCode}, signal=${child.signalCode})${this.stderrSuffix(stderr())}`
        )
      }

      const remaining = deadline - Date.now()
      try {
        const metadata = await this.dependencies.requestMetadata(
          endpoint,
          Math.min(HANDSHAKE_ATTEMPT_TIMEOUT_MS, Math.max(1, remaining))
        )
        return metadata
      } catch (error) {
        if (!(error instanceof CuaDaemonHandshakeUnavailableError)) {
          throw error
        }
        lastUnavailable = error
      }
      await this.dependencies.delay(Math.min(50, Math.max(1, deadline - Date.now())))
    }
    throw new Error(
      `CUA daemon did not become ready within ${this.startupTimeoutMs}ms${lastUnavailable ? `: ${lastUnavailable.message}` : ''}${this.stderrSuffix(stderr())}`
    )
  }

  private proxyConfiguration(endpoint: string): {
    configOverride: Partial<MCPServerConfig>
  } {
    return {
      configOverride: {
        command: this.options.binaryPath,
        args: [
          'mcp',
          '--embedded',
          '--socket',
          endpoint,
          '--host-bundle-id',
          this.options.contract.hostBundleId
        ],
        env: { ...this.options.environment },
        inheritEnv: 'minimal'
      }
    }
  }

  private assertEndpointAvailable(endpoint: string): void {
    this.assertManagedEndpoint(endpoint)
    if (this.options.platform === 'win32') {
      return
    }
    try {
      fs.lstatSync(endpoint)
      throw new Error(`CUA embedded endpoint already exists: ${endpoint}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  private assertManagedEndpoint(endpoint: string | undefined): asserts endpoint is string {
    if (!endpoint) {
      throw new Error('CUA embedded launch context is missing its endpoint')
    }
    if (this.options.platform === 'win32') {
      if (!CUA_PIPE_NAME_PATTERN.test(endpoint)) {
        throw new Error(`CUA embedded named pipe is outside the managed namespace: ${endpoint}`)
      }
      return
    }

    const resolved = path.resolve(endpoint)
    const allowedDirectories = new Set([path.resolve(os.tmpdir()), '/tmp'])
    if (
      !path.isAbsolute(endpoint) ||
      resolved !== endpoint ||
      Buffer.byteLength(endpoint) >= UNIX_SOCKET_PATH_LIMIT ||
      !allowedDirectories.has(path.dirname(endpoint)) ||
      !CUA_ENDPOINT_NAME_PATTERN.test(path.basename(endpoint))
    ) {
      throw new Error(`CUA embedded socket is outside the managed namespace: ${endpoint}`)
    }
  }

  private persistLaunchContext(
    safetyHooks: PluginRuntimeSafetyHooks | undefined,
    endpoint: string,
    identity?: EndpointIdentity
  ): void {
    if (!safetyHooks) {
      return
    }
    safetyHooks.updateLaunchContext({
      endpoint,
      ...(identity
        ? {
            endpointDevice: identity.device.toString(),
            endpointInode: identity.inode.toString()
          }
        : {})
    })
  }

  private async waitForSpawn(child: ChildProcess): Promise<void> {
    if (child.pid) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.removeListener('spawn', onSpawn)
        child.removeListener('error', onError)
      }
      const onSpawn = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  private async terminateChild(child: ChildProcess): Promise<boolean> {
    if (hasExited(child)) {
      return true
    }
    child.stdin?.end()
    if (await this.waitForExit(child, this.shutdownTimeoutMs)) {
      return true
    }
    return await this.dependencies.terminateProcess(child, { graceMs: 500 })
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (hasExited(child)) {
      return true
    }
    return await new Promise<boolean>((resolve) => {
      let timeout: NodeJS.Timeout | undefined
      const finish = (result: boolean) => {
        child.removeListener('close', onClose)
        if (timeout) {
          clearTimeout(timeout)
        }
        resolve(result)
      }
      const onClose = () => finish(true)
      child.once('close', onClose)
      timeout = setTimeout(() => finish(false), timeoutMs)
    })
  }

  private stderrSuffix(stderr: string): string {
    return stderr ? `; stderr: ${stderr}` : ''
  }
}
