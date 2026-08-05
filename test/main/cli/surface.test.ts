import { describe, expect, it } from 'vitest'
import { DEEPCHAT_ROUTE_CATALOG } from '@shared/contracts/routes'
import { CLI_SURFACE_V1, getCliSurfaceEntry, listCliSurfaceCapabilities } from '@/cli/surface'

describe('CLI surface V1', () => {
  it('contains only explicit canonical route contracts', () => {
    const methods = Array.from(CLI_SURFACE_V1.keys()).sort()

    expect(methods).toEqual(['cli.capabilities', 'cli.doctor', 'cli.status', 'cli.version'])
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
      expect.objectContaining({ method: 'cli.capabilities', effect: 'read' }),
      expect.objectContaining({ method: 'cli.doctor', effect: 'read' }),
      expect.objectContaining({ method: 'cli.status', effect: 'read' }),
      expect.objectContaining({ method: 'cli.version', effect: 'read' })
    ])
    expect(
      listCliSurfaceCapabilities().every(
        (capability) =>
          capability.callers.join(',') === 'human,agent' &&
          capability.scopes.join(',') === 'system:read' &&
          capability.transport === 'rpc' &&
          capability.approval === 'never'
      )
    ).toBe(true)
  })
})
