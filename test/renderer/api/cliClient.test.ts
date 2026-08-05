import type { DeepchatBridge } from '@shared/contracts/bridge'
import type { CliLauncherStatus } from '@shared/contracts/routes'
import { createCliClient } from '../../../src/renderer/api/CliClient'

const installedStatus = {
  state: 'installed',
  reason: null,
  owned: true,
  commandPath: '/home/user/.local/bin/deepchat',
  shellConfigPath: '/home/user/.zprofile'
} satisfies CliLauncherStatus

describe('CliClient', () => {
  it('invokes the typed launcher routes with exact inputs', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(installedStatus)
      .mockResolvedValueOnce({ ...installedStatus, state: 'not-installed', owned: false })
    const bridge: DeepchatBridge = {
      invoke,
      on: vi.fn(() => () => undefined)
    }
    const client = createCliClient(bridge)

    await expect(client.getLauncherStatus()).resolves.toEqual(installedStatus)
    await expect(client.setLauncherInstalled(false)).resolves.toMatchObject({
      state: 'not-installed',
      owned: false
    })
    expect(invoke).toHaveBeenNthCalledWith(1, 'cli.getLauncherStatus', {})
    expect(invoke).toHaveBeenNthCalledWith(2, 'cli.setLauncherInstalled', {
      installed: false
    })
  })
})
