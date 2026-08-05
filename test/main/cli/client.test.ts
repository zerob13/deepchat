import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeepchatRouteName } from '@shared/contracts/routes'
import {
  LOCAL_CONTROL_AGENT_TOKEN_ENV,
  LocalControlRpcResponseSchema
} from '@shared/contracts/localControl'
import { createCliRoutes } from '@/cli/routes'
import { CliServer } from '@/cli/server'
import type { CliRouteCaller } from '@/routes/routeRegistry'
import { runCli } from '../../../src/cli/run'

const servers: CliServer[] = []
const temporaryDirectories: string[] = []

function captureOutput(): { stream: NodeJS.WriteStream; read(): string } {
  let value = ''
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        return true
      }
    } as NodeJS.WriteStream,
    read: () => value
  }
}

async function createClientServer(options: { hang?: boolean } = {}): Promise<{
  userDataPath: string
  dispatch: ReturnType<typeof vi.fn>
}> {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'deepchat-cli-client-'))
  temporaryDirectories.push(userDataPath)
  let server: CliServer
  const routes = createCliRoutes({
    appVersion: '9.8.7',
    getStatus: () => server.getStatus(),
    hasTrustedRenderer: () => true
  })
  const dispatch = vi.fn(
    async (method: string, input: unknown, caller: CliRouteCaller): Promise<unknown> => {
      if (options.hang) return await new Promise<never>(() => undefined)
      const route = routes.get(method as DeepchatRouteName)
      if (!route) throw new Error(`Unknown test route: ${method}`)
      return await route(input, { caller })
    }
  )
  server = new CliServer({
    userDataPath,
    appVersion: '9.8.7',
    dispatch,
    log: { warn: vi.fn(), error: vi.fn() }
  })
  servers.push(server)
  await server.start()
  return { userDataPath, dispatch }
}

function runWithCapturedOutput(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): {
  result: Promise<number>
  stdout: ReturnType<typeof captureOutput>
  stderr: ReturnType<typeof captureOutput>
  signalHost: EventEmitter
} {
  const stdout = captureOutput()
  const stderr = captureOutput()
  const signalHost = new EventEmitter()
  return {
    result: runCli(argv, {
      env,
      stdout: stdout.stream,
      stderr: stderr.stream,
      signalHost: signalHost as unknown as NodeJS.Process,
      randomId: () => 'request-1',
      forceExit: vi.fn()
    }),
    stdout,
    stderr,
    signalHost
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('bundled CLI client', () => {
  it('keeps usage failures machine-readable when a post-command mode is valid', async () => {
    const invocation = runWithCapturedOutput(['system', 'status', '--json', '--unknown'], {})

    await expect(invocation.result).resolves.toBe(2)
    expect(LocalControlRpcResponseSchema.parse(JSON.parse(invocation.stdout.read()))).toMatchObject(
      {
        ok: false,
        error: { code: 'invalid_request' }
      }
    )
    expect(invocation.stderr.read()).toBe('')
  })

  it('keeps unexpected boundary failures inside the machine error contract', async () => {
    const stdout = captureOutput()
    const stderr = captureOutput()

    await expect(
      runCli(['system', 'status', '--json'], {
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        randomId: () => 'request-1',
        loadDescriptor: async () => {
          throw new Error('x'.repeat(5_000))
        }
      })
    ).resolves.toBe(8)

    const response = LocalControlRpcResponseSchema.parse(JSON.parse(stdout.read()))
    expect(response).toMatchObject({ ok: false, error: { code: 'internal_error' } })
    expect(response.ok ? '' : response.error.message).toHaveLength(4_096)
    expect(stderr.read()).toBe('')
  })

  it('discovers the running app and renders human output', async () => {
    const { userDataPath, dispatch } = await createClientServer()
    const invocation = runWithCapturedOutput(['system', 'version'], {
      DEEPCHAT_E2E_USER_DATA_DIR: userDataPath
    })

    await expect(invocation.result).resolves.toBe(0)
    expect(invocation.stdout.read()).toContain('DeepChat 9.8.7')
    expect(invocation.stdout.read()).toContain('Protocol 1, surface 1')
    expect(invocation.stderr.read()).toBe('')
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('emits exactly one canonical envelope in JSON mode', async () => {
    const { userDataPath } = await createClientServer()
    const invocation = runWithCapturedOutput(['system', 'status', '--json'], {
      DEEPCHAT_E2E_USER_DATA_DIR: userDataPath
    })

    await expect(invocation.result).resolves.toBe(0)
    const lines = invocation.stdout.read().trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(LocalControlRpcResponseSchema.parse(JSON.parse(lines[0]))).toMatchObject({
      id: 'request-1',
      ok: true,
      result: { running: true }
    })
    expect(invocation.stderr.read()).toBe('')
  })

  it('never falls back to the descriptor when Agent token selection fails', async () => {
    const { userDataPath, dispatch } = await createClientServer()
    const invocation = runWithCapturedOutput(['system', 'status', '--json'], {
      DEEPCHAT_E2E_USER_DATA_DIR: userDataPath,
      [LOCAL_CONTROL_AGENT_TOKEN_ENV]: ''
    })

    await expect(invocation.result).resolves.toBe(4)
    expect(LocalControlRpcResponseSchema.parse(JSON.parse(invocation.stdout.read()))).toMatchObject(
      {
        ok: false,
        error: { code: 'authentication_failed' }
      }
    )
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('aborts the socket and returns the stable timeout exit code', async () => {
    const { userDataPath } = await createClientServer({ hang: true })
    const invocation = runWithCapturedOutput(['system', 'status', '--json', '--timeout', '10'], {
      DEEPCHAT_E2E_USER_DATA_DIR: userDataPath
    })

    await expect(invocation.result).resolves.toBe(7)
    expect(LocalControlRpcResponseSchema.parse(JSON.parse(invocation.stdout.read()))).toMatchObject(
      {
        ok: false,
        error: { code: 'timeout' }
      }
    )
  })

  it('cancels once on SIGINT and returns the stable cancellation code', async () => {
    const { userDataPath } = await createClientServer({ hang: true })
    const invocation = runWithCapturedOutput(['system', 'status', '--json'], {
      DEEPCHAT_E2E_USER_DATA_DIR: userDataPath
    })
    invocation.signalHost.emit('SIGINT')

    await expect(invocation.result).resolves.toBe(7)
    expect(LocalControlRpcResponseSchema.parse(JSON.parse(invocation.stdout.read()))).toMatchObject(
      {
        ok: false,
        error: { code: 'cancelled' }
      }
    )
  })
})
