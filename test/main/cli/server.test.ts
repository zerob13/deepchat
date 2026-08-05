import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeepchatRouteName } from '@shared/contracts/routes'
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LOCAL_CONTROL_SCOPES,
  LOCAL_CONTROL_SURFACE_VERSION,
  LocalControlDescriptorSchema,
  LocalControlRpcResponseSchema,
  type LocalControlDescriptor,
  type LocalControlRpcResponse,
  type LocalControlScope
} from '@shared/contracts/localControl'
import { createCliRoutes } from '@/cli/routes'
import { CliServer, type AgentCliToken } from '@/cli/server'
import type { CliRouteCaller } from '@/routes/routeRegistry'

type RpcResult = Readonly<{
  status: number
  connection: string | undefined
  body: LocalControlRpcResponse
}>

const servers: CliServer[] = []
const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepchat-cli-server-'))
  temporaryDirectories.push(directory)
  return directory
}

function rpcRequest(
  descriptor: LocalControlDescriptor,
  input: {
    token?: string
    id?: string
    method?: string
    params?: unknown
    protocolVersion?: number
    surfaceVersion?: number
  },
  options: { includeContentLength?: boolean } = {}
): Promise<RpcResult> {
  const serialized = Buffer.from(
    JSON.stringify({
      protocolVersion: input.protocolVersion ?? LOCAL_CONTROL_PROTOCOL_VERSION,
      surfaceVersion: input.surfaceVersion ?? LOCAL_CONTROL_SURFACE_VERSION,
      id: input.id ?? 'request-1',
      method: input.method ?? 'cli.version',
      params: input.params ?? {}
    })
  )
  const headers: Record<string, string | number> = {
    authorization: `Bearer ${input.token ?? descriptor.token}`,
    'content-type': 'application/json'
  }
  if (options.includeContentLength !== false) headers['content-length'] = serialized.length

  return new Promise<RpcResult>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath:
          descriptor.endpoint.kind === 'unix' ? descriptor.endpoint.path : descriptor.endpoint.name,
        path: '/v1/rpc',
        method: 'POST',
        headers
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              connection:
                typeof response.headers.connection === 'string'
                  ? response.headers.connection
                  : undefined,
              body: LocalControlRpcResponseSchema.parse(
                JSON.parse(Buffer.concat(chunks).toString('utf8'))
              )
            })
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    request.once('error', reject)
    if (options.includeContentLength === false) {
      const midpoint = Math.max(1, Math.floor(serialized.length / 2))
      request.write(serialized.subarray(0, midpoint))
      request.end(serialized.subarray(midpoint))
    } else {
      request.end(serialized)
    }
  })
}

async function createTestServer(
  options: {
    resolveAgentToken?: (token: string) => AgentCliToken | null
    dispatchOutput?: (method: string) => unknown
  } = {}
): Promise<{
  server: CliServer
  descriptor: LocalControlDescriptor
  dispatch: ReturnType<typeof vi.fn>
}> {
  const userDataPath = await createTemporaryDirectory()
  let server: CliServer
  const routes = createCliRoutes({
    appVersion: '1.2.3',
    getStatus: () => server.getStatus(),
    hasTrustedRenderer: () => true
  })
  const dispatch = vi.fn(
    async (method: string, input: unknown, caller: CliRouteCaller): Promise<unknown> => {
      if (options.dispatchOutput) return options.dispatchOutput(method)
      const route = routes.get(method as DeepchatRouteName)
      if (!route) throw new Error(`Unknown test route: ${method}`)
      return await route(input, { caller })
    }
  )
  server = new CliServer({
    userDataPath,
    appVersion: '1.2.3',
    dispatch,
    resolveAgentToken: options.resolveAgentToken,
    log: { warn: vi.fn(), error: vi.fn() }
  })
  servers.push(server)
  const descriptor = await server.start()
  return { server, descriptor, dispatch }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('CLI local transport', () => {
  it('serializes a stop that races with startup', async () => {
    const userDataPath = await createTemporaryDirectory()
    const server = new CliServer({
      userDataPath,
      appVersion: '1.2.3',
      dispatch: async () => ({})
    })
    servers.push(server)

    const starting = server.start()
    const stopping = server.stop()
    await Promise.all([starting, stopping])

    expect(server.getStatus().running).toBe(false)
    await expect(stat(server.getDescriptorPath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discovers, authenticates, dispatches, and cleans up the server', async () => {
    const { server, descriptor, dispatch } = await createTestServer()
    const descriptorPath = server.getDescriptorPath()

    expect(
      LocalControlDescriptorSchema.parse(JSON.parse(await readFile(descriptorPath, 'utf8')))
    ).toEqual(descriptor)

    const response = await rpcRequest(descriptor, {})
    expect(response).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          appVersion: '1.2.3',
          protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
          surfaceVersion: LOCAL_CONTROL_SURFACE_VERSION
        }
      }
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
      kind: 'cli',
      principal: 'human',
      scopes: LOCAL_CONTROL_SCOPES
    })

    await server.stop()
    await expect(stat(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    if (descriptor.endpoint.kind === 'unix') {
      await expect(stat(descriptor.endpoint.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('fails closed on invalid authentication without dispatching', async () => {
    const { descriptor, dispatch } = await createTestServer()

    const response = await rpcRequest(descriptor, { token: 'x'.repeat(43) })

    expect(response).toMatchObject({
      status: 401,
      connection: 'close',
      body: { ok: false, error: { code: 'authentication_failed' } }
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('enforces protocol versions and the explicit surface before dispatch', async () => {
    const { descriptor, dispatch } = await createTestServer()

    const incompatible = await rpcRequest(descriptor, { protocolVersion: 2 })
    const hidden = await rpcRequest(descriptor, { method: 'settings.getSnapshot' })

    expect(incompatible).toMatchObject({
      status: 409,
      body: { ok: false, error: { code: 'unsupported_version' } }
    })
    expect(hidden).toMatchObject({
      status: 404,
      body: { ok: false, error: { code: 'not_found' } }
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reports invalid route output as an internal contract failure', async () => {
    const { descriptor } = await createTestServer({
      dispatchOutput: () => ({ appVersion: '' })
    })

    const response = await rpcRequest(descriptor, {})

    expect(response).toMatchObject({
      status: 500,
      body: { ok: false, error: { code: 'internal_error' } }
    })
  })

  it('requires Content-Length and never accepts implicit chunked RPC input', async () => {
    const { descriptor, dispatch } = await createTestServer()

    const response = await rpcRequest(descriptor, {}, { includeContentLength: false })

    expect(response).toMatchObject({
      status: 411,
      body: { ok: false, error: { code: 'invalid_request' } }
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects request bodies on artifact download endpoints', async () => {
    const { descriptor } = await createTestServer()
    const body = await new Promise<LocalControlRpcResponse>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath:
            descriptor.endpoint.kind === 'unix'
              ? descriptor.endpoint.path
              : descriptor.endpoint.name,
          path: '/v1/artifacts/abcdefghijklmnop',
          method: 'GET',
          headers: {
            authorization: `Bearer ${descriptor.token}`,
            'content-length': 1
          }
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.once('error', reject)
          response.once('end', () => {
            try {
              resolve(
                LocalControlRpcResponseSchema.parse(
                  JSON.parse(Buffer.concat(chunks).toString('utf8'))
                )
              )
            } catch (error) {
              reject(error)
            }
          })
        }
      )
      request.once('error', reject)
      request.end('x')
    })

    expect(body).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  })

  it('applies agent expiry and scopes independently of the bearer token', async () => {
    let scopes: readonly LocalControlScope[] = ['models:read']
    let expiresAt = Date.now() - 1
    const agentToken = 'g'.repeat(43)
    const { descriptor, dispatch } = await createTestServer({
      resolveAgentToken: (token) =>
        token === agentToken
          ? {
              conversationId: 'conversation-1',
              expiresAt,
              scopes
            }
          : null
    })

    const expired = await rpcRequest(descriptor, { token: agentToken })
    expiresAt = Date.now() + 60_000
    const denied = await rpcRequest(descriptor, { token: agentToken })
    scopes = ['system:read']
    const allowed = await rpcRequest(descriptor, { token: agentToken })

    expect(expired).toMatchObject({
      status: 401,
      body: { ok: false, error: { code: 'authentication_failed' } }
    })
    expect(denied).toMatchObject({
      status: 403,
      body: { ok: false, error: { code: 'permission_denied' } }
    })
    expect(allowed).toMatchObject({ status: 200, body: { ok: true } })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
      kind: 'cli',
      principal: 'agent',
      conversationId: 'conversation-1',
      scopes: ['system:read']
    })
  })
})
