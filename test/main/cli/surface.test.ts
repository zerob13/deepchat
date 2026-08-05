import { describe, expect, it } from 'vitest'
import { DEEPCHAT_ROUTE_CATALOG } from '@shared/contracts/routes'
import { CLI_SURFACE_V1, getCliSurfaceEntry, listCliSurfaceCapabilities } from '@/cli/surface'

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
  })

  it('publishes stable sorted capability metadata', () => {
    expect(listCliSurfaceCapabilities()).toEqual([
      expect.objectContaining({ method: 'artifacts.delete', effect: 'local-maintenance' }),
      expect.objectContaining({ method: 'artifacts.describe', effect: 'read' }),
      expect.objectContaining({ method: 'artifacts.read', effect: 'read', transport: 'download' }),
      expect.objectContaining({
        method: 'audio.transcribeArtifact',
        effect: 'compute',
        transport: 'rpc',
        callers: ['human', 'agent'],
        scopes: ['audio:transcribe', 'artifacts:read']
      }),
      expect.objectContaining({
        method: 'audio.transcribeUpload',
        effect: 'compute',
        transport: 'upload',
        callers: ['human']
      }),
      expect.objectContaining({ method: 'cli.capabilities', effect: 'read' }),
      expect.objectContaining({ method: 'cli.doctor', effect: 'read' }),
      expect.objectContaining({ method: 'cli.status', effect: 'read' }),
      expect.objectContaining({ method: 'cli.version', effect: 'read' }),
      expect.objectContaining({
        method: 'images.generate',
        effect: 'compute',
        transport: 'stream'
      }),
      expect.objectContaining({
        method: 'models.invoke',
        effect: 'compute',
        transport: 'stream'
      }),
      expect.objectContaining({
        method: 'ocr.clearCache',
        effect: 'local-maintenance',
        approval: 'never',
        callers: ['human']
      }),
      expect.objectContaining({
        method: 'ocr.extractArtifact',
        effect: 'compute',
        transport: 'rpc',
        callers: ['human', 'agent'],
        scopes: ['ocr:extract', 'artifacts:read']
      }),
      expect.objectContaining({
        method: 'ocr.extractUpload',
        effect: 'compute',
        transport: 'upload',
        callers: ['human']
      }),
      expect.objectContaining({ method: 'ocr.getRuntimeStatus', effect: 'read' }),
      expect.objectContaining({ method: 'providers.listPublic', effect: 'read' }),
      expect.objectContaining({
        method: 'speech.generate',
        effect: 'compute',
        transport: 'stream'
      }),
      expect.objectContaining({
        method: 'videos.generate',
        effect: 'compute',
        transport: 'stream'
      })
    ])
    expect(
      listCliSurfaceCapabilities().every((capability) => capability.approval === 'never')
    ).toBe(true)
  })
})
