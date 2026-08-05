import type { DeepchatBridge } from '@shared/contracts/bridge'
import { cliGetLauncherStatusRoute, cliSetLauncherInstalledRoute } from '@shared/contracts/routes'
import { getDeepchatBridge } from './core'

export function createCliClient(bridge: DeepchatBridge = getDeepchatBridge()) {
  async function getLauncherStatus() {
    return await bridge.invoke(cliGetLauncherStatusRoute.name, {})
  }

  async function setLauncherInstalled(installed: boolean) {
    return await bridge.invoke(cliSetLauncherInstalledRoute.name, { installed })
  }

  return {
    getLauncherStatus,
    setLauncherInstalled
  }
}

export type CliClient = ReturnType<typeof createCliClient>
