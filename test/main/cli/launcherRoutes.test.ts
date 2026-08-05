import { describe, expect, it, vi } from 'vitest'
import { cliGetLauncherStatusRoute, cliSetLauncherInstalledRoute } from '@shared/contracts/routes'
import { createCliLauncherRoutes } from '@/cli/launcherRoutes'

const installedStatus = {
  state: 'installed' as const,
  reason: null,
  owned: true,
  commandPath: '/home/user/.local/bin/deepchat',
  shellConfigPath: '/home/user/.zprofile'
}

describe('createCliLauncherRoutes', () => {
  it('exposes launcher state only to renderer callers', async () => {
    const launcher = {
      getStatus: vi.fn(async () => installedStatus),
      setInstalled: vi.fn(async () => installedStatus)
    }
    const routes = createCliLauncherRoutes(launcher)
    const getStatus = routes.get(cliGetLauncherStatusRoute.name)
    const setInstalled = routes.get(cliSetLauncherInstalledRoute.name)
    if (!getStatus || !setInstalled) throw new Error('Expected CLI launcher routes')
    const rendererContext = {
      caller: { kind: 'renderer' as const, webContentsId: 1, windowId: 2 }
    }

    await expect(getStatus({}, rendererContext)).resolves.toEqual(installedStatus)
    await expect(setInstalled({ installed: true }, rendererContext)).resolves.toEqual(
      installedStatus
    )
    expect(launcher.setInstalled).toHaveBeenCalledWith(true)

    await expect(
      getStatus(
        {},
        {
          caller: {
            kind: 'cli',
            principal: 'human',
            connectionId: 'connection-1',
            scopes: ['system:read']
          }
        }
      )
    ).rejects.toThrow('renderer caller')
    await expect(
      setInstalled(
        { installed: false },
        {
          caller: {
            kind: 'cli',
            principal: 'human',
            connectionId: 'connection-1',
            scopes: ['system:write']
          }
        }
      )
    ).rejects.toThrow('renderer caller')
    expect(launcher.setInstalled).toHaveBeenCalledTimes(1)
  })
})
