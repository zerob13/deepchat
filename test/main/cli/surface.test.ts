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
      'models.getPublicConfig',
      'models.invoke',
      'models.listRuntime',
      'models.resetConfig',
      'models.setPublicConfig',
      'models.setStatus',
      'ocr.clearCache',
      'ocr.extractArtifact',
      'ocr.extractUpload',
      'ocr.getRuntimeStatus',
      'providers.addPublic',
      'providers.listPublic',
      'providers.remove',
      'providers.setCredential',
      'providers.testPublicConnection',
      'providers.updatePublic',
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

  it('never projects provider credential material into approval or audit metadata', () => {
    const entry = getCliSurfaceEntry('providers.setCredential')!
    const input = {
      providerId: 'provider-1',
      action: 'set',
      kind: 'api-key',
      value: 'super-secret'
    }

    expect(entry.auditProjection?.(input)).toEqual({
      providerId: 'provider-1',
      action: 'set',
      kind: 'api-key'
    })
    expect(entry.approvalDisplay?.(input)).toEqual({
      providerId: 'provider-1',
      action: 'set',
      kind: 'api-key'
    })
    expect(JSON.stringify(entry.approvalDisplay?.(input))).not.toContain('super-secret')
  })

  it('shows safe mutation values in approvals while keeping audits structural', () => {
    const providerEntry = getCliSurfaceEntry('providers.updatePublic')!
    const providerInput = {
      providerId: 'provider-1',
      updates: { baseUrl: 'https://api.example/v1', enabled: false }
    }
    expect(providerEntry.auditProjection?.(providerInput)).toEqual({
      providerId: 'provider-1',
      fields: ['baseUrl', 'enabled']
    })
    expect(providerEntry.approvalDisplay?.(providerInput)).toEqual(providerInput)

    const modelEntry = getCliSurfaceEntry('models.setPublicConfig')!
    const modelInput = {
      providerId: 'provider-1',
      modelId: 'model-1',
      config: { maxTokens: 4096, contextLength: 32768 }
    }
    expect(modelEntry.approvalDisplay?.(modelInput)).toEqual(modelInput)
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
      expect.objectContaining({ method: 'models.getPublicConfig', possibleEffects: ['read'] }),
      expect.objectContaining({
        method: 'models.invoke',
        possibleEffects: ['compute'],
        transport: 'stream'
      }),
      expect.objectContaining({ method: 'models.listRuntime', possibleEffects: ['read'] }),
      expect.objectContaining({
        method: 'models.resetConfig',
        possibleEffects: ['execution-config'],
        approval: 'policy'
      }),
      expect.objectContaining({
        method: 'models.setPublicConfig',
        possibleEffects: ['execution-config'],
        approval: 'policy'
      }),
      expect.objectContaining({
        method: 'models.setStatus',
        possibleEffects: ['execution-config'],
        approval: 'policy'
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
      expect.objectContaining({
        method: 'providers.addPublic',
        possibleEffects: ['execution-config'],
        approval: 'policy'
      }),
      expect.objectContaining({ method: 'providers.listPublic', possibleEffects: ['read'] }),
      expect.objectContaining({
        method: 'providers.remove',
        possibleEffects: ['destructive'],
        approval: 'policy'
      }),
      expect.objectContaining({
        method: 'providers.setCredential',
        possibleEffects: ['credential'],
        approval: 'policy'
      }),
      expect.objectContaining({
        method: 'providers.testPublicConnection',
        possibleEffects: ['compute'],
        approval: 'never'
      }),
      expect.objectContaining({
        method: 'providers.updatePublic',
        possibleEffects: ['execution-config'],
        approval: 'policy'
      }),
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
        .filter((capability) => capability.approval === 'policy')
        .map((capability) => capability.method)
    ).toEqual([
      'models.resetConfig',
      'models.setPublicConfig',
      'models.setStatus',
      'providers.addPublic',
      'providers.remove',
      'providers.setCredential',
      'providers.updatePublic',
      'settings.updatePublic'
    ])
  })
})
