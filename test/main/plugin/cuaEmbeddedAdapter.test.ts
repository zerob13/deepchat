import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CuaDaemonCompatibilityError,
  CuaEmbeddedRuntimeAdapter,
  createCuaEmbeddedEndpoint,
  requestCuaDaemonMetadata,
  validateCuaDaemonMetadata,
  type CuaDaemonMetadata
} from '@/plugin/cuaEmbeddedAdapter'
import type { CuaEmbeddedRuntimeContract } from '@shared/types/plugin'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: actual
  }
})

const contract: CuaEmbeddedRuntimeContract = {
  hostBundleId: 'com.wefonk.deepchat',
  driverVersion: '0.12.6',
  contractVersion: '0.2.0',
  toolsListSchemaVersion: '1',
  capabilityVersion: '1',
  mcpProtocolVersion: '2025-06-18'
}

const metadata = (pid: number): CuaDaemonMetadata => ({
  driver_version: '0.12.6',
  contract_version: '0.2.0',
  tools_list_schema_version: '1',
  capability_version: '1',
  mcp_protocol_version: '2025-06-18',
  pid,
  embedded: true,
  host_bundle_id: 'com.wefonk.deepchat'
})

const fakeChild = (pid = 4242) => {
  const child = new EventEmitter() as ChildProcess
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    stdin,
    stdout: null,
    stderr,
    killed: false
  })
  stdin.once('finish', () => {
    child.exitCode = 0
    child.emit('close', 0, null)
  })
  return child
}

const tempRoots: string[] = []

describe('CuaEmbeddedRuntimeAdapter', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('generates target-safe private endpoint names', () => {
    const generation = '01234567-89ab-cdef-0123-456789abcdef'

    expect(createCuaEmbeddedEndpoint('win32', generation, 123)).toBe(
      '\\\\.\\pipe\\deepchat-cua-123-0123456789ab'
    )
    const unixEndpoint = createCuaEmbeddedEndpoint('linux', generation, 123, '/a'.repeat(80))
    expect(unixEndpoint).toBe('/tmp/deepchat-cua-123-0123456789ab.sock')
    expect(Buffer.byteLength(unixEndpoint)).toBeLessThan(104)
  })

  it('rejects daemon metadata that does not bind to the spawned child', () => {
    expect(() => validateCuaDaemonMetadata(metadata(42), 43, contract)).toThrow(
      CuaDaemonCompatibilityError
    )
    expect(() =>
      validateCuaDaemonMetadata(
        {
          ...metadata(42),
          host_bundle_id: 'com.attacker.host'
        },
        42,
        contract
      )
    ).toThrow(/host_bundle_id mismatch/)
  })

  it('performs the newline-delimited daemon metadata handshake', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'deepchat-cua-handshake-'))
    tempRoots.push(tempRoot)
    const endpoint = createCuaEmbeddedEndpoint(
      process.platform,
      '01234567-89ab-cdef-0123-456789abcdef',
      process.pid,
      tempRoot
    )
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ ok: true, result: metadata(process.pid) })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })

    try {
      await expect(requestCuaDaemonMetadata(endpoint)).resolves.toEqual(metadata(process.pid))
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('keeps the daemon warm and routes the MCP proxy to its verified endpoint', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => child)
    const requestMetadata = vi.fn(async () => metadata(child.pid!))
    const terminateProcess = vi.fn(async () => true)
    const cleanupEndpoint = vi.fn()
    const endpoint = '/tmp/deepchat-cua-test.sock'
    const originalSecret = process.env.DEEPCHAT_TEST_SECRET
    const originalDisplay = process.env.DISPLAY
    process.env.DEEPCHAT_TEST_SECRET = 'do-not-inherit'
    process.env.DISPLAY = ':0'

    try {
      const adapter = new CuaEmbeddedRuntimeAdapter(
        {
          binaryPath: '/plugin/cua-driver',
          platform: 'linux',
          contract,
          environment: {
            CUA_DRIVER_RS_SPAWN_UIA_WORKER: '0',
            DEEPCHAT_PLUGIN_ID: 'com.deepchat.plugins.cua'
          }
        },
        {
          spawnProcess,
          requestMetadata,
          createEndpoint: () => endpoint,
          captureEndpointIdentity: () => ({ device: 7n, inode: 11n }),
          cleanupEndpoint,
          terminateProcess
        }
      )

      await expect(adapter.start('tool')).resolves.toEqual({
        configOverride: {
          command: '/plugin/cua-driver',
          args: [
            'mcp',
            '--embedded',
            '--socket',
            endpoint,
            '--host-bundle-id',
            'com.wefonk.deepchat'
          ],
          env: {
            CUA_DRIVER_RS_SPAWN_UIA_WORKER: '0',
            DEEPCHAT_PLUGIN_ID: 'com.deepchat.plugins.cua'
          },
          inheritEnv: 'minimal'
        }
      })
      const [, args, options] = spawnProcess.mock.calls[0]
      expect(args).toEqual([
        'serve',
        '--embedded',
        '--parent-liveness-stdio',
        '--no-permissions-gate',
        '--socket',
        endpoint,
        '--host-bundle-id',
        'com.wefonk.deepchat',
        '--permission-mode',
        'standard'
      ])
      expect(options.env).toMatchObject({
        DISPLAY: ':0',
        CUA_DRIVER_RS_SPAWN_UIA_WORKER: '0',
        DEEPCHAT_PLUGIN_ID: 'com.deepchat.plugins.cua'
      })
      expect(options.env).not.toHaveProperty('DEEPCHAT_TEST_SECRET')

      await expect(adapter.start('tool')).resolves.toMatchObject({
        configOverride: {
          args: [
            'mcp',
            '--embedded',
            '--socket',
            endpoint,
            '--host-bundle-id',
            'com.wefonk.deepchat'
          ]
        }
      })
      expect(spawnProcess).toHaveBeenCalledTimes(1)

      await adapter.stop()
      expect(terminateProcess).not.toHaveBeenCalled()
      expect(cleanupEndpoint).toHaveBeenCalledWith(endpoint, 'linux', {
        device: 7n,
        inode: 11n
      })
    } finally {
      if (originalSecret === undefined) {
        delete process.env.DEEPCHAT_TEST_SECRET
      } else {
        process.env.DEEPCHAT_TEST_SECRET = originalSecret
      }
      if (originalDisplay === undefined) {
        delete process.env.DISPLAY
      } else {
        process.env.DISPLAY = originalDisplay
      }
    }
  })

  it('closes parent-liveness stdin when metadata validation fails', async () => {
    const child = fakeChild()
    const adapter = new CuaEmbeddedRuntimeAdapter(
      {
        binaryPath: '/plugin/cua-driver',
        platform: 'linux',
        contract,
        environment: {},
        startupTimeoutMs: 100
      },
      {
        spawnProcess: () => child,
        requestMetadata: async () => ({ ...metadata(child.pid!), driver_version: '0.12.5' }),
        createEndpoint: () => '/tmp/deepchat-cua-invalid.sock',
        captureEndpointIdentity: () => undefined,
        cleanupEndpoint: vi.fn()
      }
    )
    const stdinEnd = vi.spyOn(child.stdin!, 'end')

    await expect(adapter.start('tool')).rejects.toThrow(/driver_version mismatch/)
    expect(stdinEnd).toHaveBeenCalled()
    expect(child.exitCode).toBe(0)
  })
})
