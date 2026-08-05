import { describe, expect, it } from 'vitest'
import { DEEPCHAT_ROUTE_CATALOG } from '@shared/contracts/routes'
import {
  CLI_SURFACE_V1,
  getCliSurfaceEntry,
  listCliSurfaceCapabilities,
  resolveCliSurfaceEffect
} from '@/cli/surface'

describe('CLI surface V1', () => {
  it('contains only explicit canonical route contracts', () => {
    const methods = Array.from(CLI_SURFACE_V1.keys()).sort()

    expect(methods).toEqual([
      'artifacts.delete',
      'artifacts.describe',
      'artifacts.read',
      'audio.transcribeArtifact',
      'audio.transcribeUpload',
      'cli.capabilities',
      'cli.doctor',
      'cli.status',
      'cli.version',
      'images.generate',
      'models.invoke',
      'ocr.clearCache',
      'ocr.extractArtifact',
      'ocr.extractUpload',
      'ocr.getRuntimeStatus',
      'providers.listPublic',
      'settings.getPublic',
      'settings.updatePublic',
      'speech.generate',
      'videos.generate'
    ])
    for (const [method, entry] of CLI_SURFACE_V1) {
      expect(entry.contract).toBe(
        DEEPCHAT_ROUTE_CATALOG[method as keyof typeof DEEPCHAT_ROUTE_CATALOG]
      )
    }
  })

  it('denies methods that are not explicitly listed', () => {
    expect(getCliSurfaceEntry('settings.getSnapshot')).toBeUndefined()
    expect(getCliSurfaceEntry('mcp.callTool')).toBeUndefined()
    expect(getCliSurfaceEntry('databaseSecurity.disable')).toBeUndefined()
    expect(getCliSurfaceEntry('approvals.resolve')).toBeUndefined()
  })

  it('classifies public setting changes from their validated key', () => {
    const entry = getCliSurfaceEntry('settings.updatePublic')!

    expect(
      resolveCliSurfaceEffect(entry, {
        changes: [{ key: 'fontSizeLevel', value: 3 }]
      })
    ).toBe('preference-write')
    expect(
      resolveCliSurfaceEffect(entry, {
        changes: [{ key: 'loggingEnabled', value: true }]
      })
    ).toBe('security-config')
    expect(
      resolveCliSurfaceEffect(entry, {
        changes: [{ key: 'ocrBackend', value: 'cpu' }]
      })
    ).toBe('execution-config')
    expect(
      entry.agentInputAllowed?.({ changes: [{ key: 'privacyModeEnabled', value: true }] })
    ).toBe(false)
    expect(
      entry.approvalDisplay?.({ changes: [{ key: 'privacyModeEnabled', value: true }] })
    ).toEqual({ changes: [{ key: 'privacyModeEnabled', value: true }] })
  })

  it('publishes stable sorted capability metadata', () => {
    expect(listCliSurfaceCapabilities()).toEqual([
      expect.objectContaining({
        method: 'artifacts.delete',
        possibleEffects: ['local-maintenance']
      }),
      expect.objectContaining({ method: 'artifacts.describe', possibleEffects: ['read'] }),
      expect.objectContaining({
        method: 'artifacts.read',
        possibleEffects: ['read'],
        transport: 'download'
      }),
      expect.objectContaining({
        method: 'audio.transcribeArtifact',
        possibleEffects: ['compute'],
        transport: 'rpc',
        callers: ['human', 'agent'],
        scopes: ['audio:transcribe', 'artifacts:read']
      }),
      expect.objectContaining({
        method: 'audio.transcribeUpload',
        possibleEffects: ['compute'],
        transport: 'upload',
        callers: ['human']
      }),
      expect.objectContaining({ method: 'cli.capabilities', possibleEffects: ['read'] }),
      expect.objectContaining({ method: 'cli.doctor', possibleEffects: ['read'] }),
      expect.objectContaining({ method: 'cli.status', possibleEffects: ['read'] }),
      expect.objectContaining({ method: 'cli.version', possibleEffects: ['read'] }),
      expect.objectContaining({
        method: 'images.generate',
        possibleEffects: ['compute'],
        transport: 'stream'
      }),
      expect.objectContaining({
        method: 'models.invoke',
        possibleEffects: ['compute'],
        transport: 'stream'
      }),
      expect.objectContaining({
        method: 'ocr.clearCache',
        possibleEffects: ['local-maintenance'],
        approval: 'never',
        callers: ['human']
      }),
      expect.objectContaining({
        method: 'ocr.extractArtifact',
        possibleEffects: ['compute'],
        transport: 'rpc',
        callers: ['human', 'agent'],
        scopes: ['ocr:extract', 'artifacts:read']
      }),
      expect.objectContaining({
        method: 'ocr.extractUpload',
        possibleEffects: ['compute'],
        transport: 'upload',
        callers: ['human']
      }),
      expect.objectContaining({ method: 'ocr.getRuntimeStatus', possibleEffects: ['read'] }),
      expect.objectContaining({ method: 'providers.listPublic', possibleEffects: ['read'] }),
      expect.objectContaining({ method: 'settings.getPublic', possibleEffects: ['read'] }),
      expect.objectContaining({
        method: 'settings.updatePublic',
        possibleEffects: ['preference-write', 'execution-config', 'security-config'],
        approval: 'policy'
      }),
      expect.objectContaining({
        method: 'speech.generate',
        possibleEffects: ['compute'],
        transport: 'stream'
      }),
      expect.objectContaining({
        method: 'videos.generate',
        possibleEffects: ['compute'],
        transport: 'stream'
      })
    ])
    expect(
      listCliSurfaceCapabilities()
        .filter((capability) => capability.method !== 'settings.updatePublic')
        .every((capability) => capability.approval === 'never')
    ).toBe(true)
  })
})
