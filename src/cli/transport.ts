import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import {
  LOCAL_CONTROL_RPC_PATH,
  LocalControlRpcRequestSchema,
  LocalControlRpcResponseSchema,
  type LocalControlDescriptor,
  type LocalControlRpcResponse
} from '@shared/contracts/localControl'
import type { JsonValue } from '@shared/contracts/json'
import { CLI_EXIT_CODES, CliClientError } from './errors'

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export const CLI_VERSION =
  typeof __DEEPCHAT_CLI_VERSION__ === 'string' ? __DEEPCHAT_CLI_VERSION__ : 'development'

export type CliRpcInvocation = Readonly<{
  descriptor: LocalControlDescriptor
  token: string
  id: string
  method: string
  params: JsonValue
  signal: AbortSignal
}>

function transportFailure(message: string, retriable = true): CliClientError {
  return new CliClientError('unavailable', message, CLI_EXIT_CODES.unavailable, retriable)
}

function protocolFailure(message: string): CliClientError {
  return new CliClientError('internal_error', message, CLI_EXIT_CODES.internal)
}

function declaredResponseLength(
  headers: IncomingHttpHeaders,
  distinctValues: readonly string[] | undefined
): number | null {
  if (distinctValues && distinctValues.length !== 1) {
    throw protocolFailure('DeepChat returned multiple Content-Length headers')
  }
  const raw = distinctValues?.[0] ?? headers['content-length']
  if (raw === undefined) return null
  if (Array.isArray(raw) || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw protocolFailure('DeepChat returned an invalid Content-Length')
  }
  const length = Number(raw)
  if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) {
    throw protocolFailure('DeepChat response exceeds the CLI byte limit')
  }
  return length
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new CliClientError('cancelled', 'CLI request was cancelled', CLI_EXIT_CODES.cancelled)
}

export async function invokeLocalControlRpc(
  invocation: CliRpcInvocation
): Promise<LocalControlRpcResponse> {
  if (invocation.signal.aborted) throw abortReason(invocation.signal)
  const body = Buffer.from(
    JSON.stringify(
      LocalControlRpcRequestSchema.parse({
        protocolVersion: invocation.descriptor.protocolVersion,
        surfaceVersion: invocation.descriptor.surfaceVersion,
        id: invocation.id,
        method: invocation.method,
        params: invocation.params
      })
    ),
    'utf8'
  )

  return await new Promise<LocalControlRpcResponse>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      callback()
    }
    const request = httpRequest({
      socketPath:
        invocation.descriptor.endpoint.kind === 'unix'
          ? invocation.descriptor.endpoint.path
          : invocation.descriptor.endpoint.name,
      path: LOCAL_CONTROL_RPC_PATH,
      method: 'POST',
      agent: false,
      signal: invocation.signal,
      headers: {
        authorization: `Bearer ${invocation.token}`,
        'content-type': 'application/json',
        'content-length': body.length,
        connection: 'close',
        'user-agent': `DeepChat-CLI/${CLI_VERSION}`
      }
    })

    request.once('response', (response) => {
      const contentTypes = response.headersDistinct['content-type']
      const contentType = contentTypes?.[0] ?? response.headers['content-type']
      const [mediaType, ...parameters] =
        typeof contentType === 'string'
          ? contentType.split(';').map((part) => part.trim().toLowerCase())
          : []
      if (
        (contentTypes && contentTypes.length !== 1) ||
        mediaType !== 'application/json' ||
        !parameters.every((parameter) => parameter === 'charset=utf-8')
      ) {
        response.resume()
        finish(() => reject(protocolFailure('DeepChat returned a non-JSON response')))
        return
      }
      if (response.headers['content-encoding'] !== undefined) {
        response.resume()
        finish(() => reject(protocolFailure('Compressed local responses are not supported')))
        return
      }

      let expectedLength: number | null
      try {
        expectedLength = declaredResponseLength(
          response.headers,
          response.headersDistinct['content-length']
        )
      } catch (error) {
        response.destroy()
        finish(() => reject(error))
        return
      }

      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (rawChunk: Buffer | string) => {
        if (settled) return
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy()
          finish(() => reject(protocolFailure('DeepChat response exceeds the CLI byte limit')))
          return
        }
        chunks.push(chunk)
      })
      response.once('error', (error) => finish(() => reject(transportFailure(error.message))))
      response.once('end', () => {
        if (settled) return
        if (expectedLength !== null && expectedLength !== size) {
          finish(() => reject(protocolFailure('DeepChat response length did not match')))
          return
        }
        try {
          const parsed = LocalControlRpcResponseSchema.parse(
            JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
          )
          const isHttpSuccess =
            (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300
          if (parsed.ok !== isHttpSuccess) {
            throw protocolFailure('DeepChat HTTP status and response envelope disagree')
          }
          if (parsed.id !== invocation.id && !(!parsed.ok && parsed.id === 'unknown')) {
            throw protocolFailure('DeepChat response ID did not match the request')
          }
          finish(() => resolve(parsed))
        } catch (error) {
          finish(() =>
            reject(
              error instanceof CliClientError
                ? error
                : protocolFailure('DeepChat returned an invalid response envelope')
            )
          )
        }
      })
    })
    request.once('error', (error: NodeJS.ErrnoException) => {
      if (invocation.signal.aborted) {
        finish(() => reject(abortReason(invocation.signal)))
        return
      }
      const message =
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EPIPE'
          ? 'DeepChat local control server is unavailable'
          : `Cannot connect to DeepChat: ${error.message}`
      finish(() => reject(transportFailure(message)))
    })
    request.end(body)
  })
}
