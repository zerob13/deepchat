import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LOCAL_CONTROL_SURFACE_VERSION,
  createLocalControlSuccess,
  type LocalControlDescriptor,
  type LocalControlEndpoint
} from '@shared/contracts/localControl'
import { invokeLocalControlRpc } from '../../../src/cli/transport'

const servers: Server[] = []
const socketPaths: string[] = []

function createEndpoint(): LocalControlEndpoint {
  if (process.platform === 'win32') {
    return { kind: 'pipe', name: `\\\\.\\pipe\\deepchat-cli-test-${randomUUID()}` }
  }
  const socketPath = `/tmp/deepchat-cli-${randomUUID()}.sock`
  socketPaths.push(socketPath)
  return { kind: 'unix', path: socketPath }
}

async function listen(listener: RequestListener): Promise<LocalControlDescriptor> {
  const endpoint = createEndpoint()
  const server = createServer(listener)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint.kind === 'unix' ? endpoint.path : endpoint.name, resolve)
  })
  return {
    protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
    surfaceVersion: LOCAL_CONTROL_SURFACE_VERSION,
    appVersion: '1.2.3',
    endpoint,
    pid: process.pid,
    token: 't'.repeat(43),
    startedAt: Date.now()
  }
}

async function invoke(descriptor: LocalControlDescriptor) {
  return await invokeLocalControlRpc({
    descriptor,
    token: descriptor.token,
    id: 'request-1',
    method: 'cli.version',
    params: {},
    signal: new AbortController().signal
  })
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
  await Promise.all(socketPaths.splice(0).map((socketPath) => rm(socketPath, { force: true })))
})

describe('CLI response transport', () => {
  it('rejects a response envelope for another request', async () => {
    const descriptor = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify(createLocalControlSuccess('request-2', {})))
    })

    await expect(invoke(descriptor)).rejects.toMatchObject({
      code: 'internal_error',
      exitCode: 8
    })
  })

  it('rejects an oversized declared response before buffering it', async () => {
    const descriptor = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('content-length', 16 * 1024 * 1024 + 1)
      response.flushHeaders()
    })

    await expect(invoke(descriptor)).rejects.toMatchObject({
      code: 'internal_error',
      exitCode: 8
    })
  })

  it('requires HTTP status and the typed envelope to agree', async () => {
    const descriptor = await listen((_request, response) => {
      response.statusCode = 500
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify(createLocalControlSuccess('request-1', {})))
    })

    await expect(invoke(descriptor)).rejects.toMatchObject({
      code: 'internal_error',
      exitCode: 8
    })
  })
})
