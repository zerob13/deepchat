import { describe, expect, it } from 'vitest'
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LOCAL_CONTROL_SURFACE_VERSION,
  LocalControlDescriptorSchema,
  LocalControlRpcRequestSchema,
  LocalControlScopesSchema,
  createLocalControlFailure,
  createLocalControlSuccess
} from '@shared/contracts/localControl'

describe('local-control contracts', () => {
  it('accepts a bounded private endpoint descriptor', () => {
    expect(
      LocalControlDescriptorSchema.parse({
        protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
        surfaceVersion: LOCAL_CONTROL_SURFACE_VERSION,
        appVersion: '1.2.3',
        endpoint: { kind: 'unix', path: '/tmp/deepchat.sock' },
        pid: 42,
        token: 'a'.repeat(43),
        startedAt: 1_000
      })
    ).toMatchObject({
      endpoint: { kind: 'unix', path: '/tmp/deepchat.sock' },
      token: 'a'.repeat(43)
    })
  })

  it('rejects malformed descriptors and duplicate scopes', () => {
    expect(() =>
      LocalControlDescriptorSchema.parse({
        protocolVersion: 2,
        surfaceVersion: LOCAL_CONTROL_SURFACE_VERSION,
        appVersion: '1.2.3',
        endpoint: { kind: 'unix', path: '/tmp/deepchat.sock\0hidden' },
        pid: 0,
        token: 'secret',
        startedAt: 1_000,
        ignored: true
      })
    ).toThrow()
    expect(() => LocalControlScopesSchema.parse(['models:invoke', 'models:invoke'])).toThrow(
      'Duplicate local-control scope'
    )
  })

  it('requires versioned JSON RPC requests with domain methods', () => {
    expect(
      LocalControlRpcRequestSchema.parse({
        protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
        surfaceVersion: LOCAL_CONTROL_SURFACE_VERSION,
        id: 'request-1',
        method: 'models.invoke',
        params: { prompt: 'hello' }
      })
    ).toMatchObject({ id: 'request-1', method: 'models.invoke' })

    expect(() =>
      LocalControlRpcRequestSchema.parse({
        protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
        surfaceVersion: LOCAL_CONTROL_SURFACE_VERSION,
        id: 'request with spaces',
        method: 'invoke',
        params: {}
      })
    ).toThrow()
  })

  it('creates stable success and failure envelopes', () => {
    expect(createLocalControlSuccess('request-1', { ready: true })).toEqual({
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      surfaceVersion: LOCAL_CONTROL_SURFACE_VERSION,
      id: 'request-1',
      ok: true,
      result: { ready: true }
    })
    expect(
      createLocalControlFailure('request-2', {
        code: 'unavailable',
        message: 'Desktop application is not running',
        retriable: true
      })
    ).toMatchObject({
      id: 'request-2',
      ok: false,
      error: { code: 'unavailable', retriable: true }
    })
  })
})
