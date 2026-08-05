import { cliGetLauncherStatusRoute, cliSetLauncherInstalledRoute } from '@shared/contracts/routes'
import {
  createRouteMap,
  requireRendererCaller,
  type DeepchatRouteMap
} from '@/routes/routeRegistry'
import type { CliLauncherService } from './launcherService'

export function createCliLauncherRoutes(
  launcher: Pick<CliLauncherService, 'getStatus' | 'setInstalled'>
): DeepchatRouteMap {
  return createRouteMap([
    [
      cliGetLauncherStatusRoute.name,
      async (rawInput, context) => {
        requireRendererCaller(context)
        cliGetLauncherStatusRoute.input.parse(rawInput)
        return cliGetLauncherStatusRoute.output.parse(await launcher.getStatus())
      }
    ],
    [
      cliSetLauncherInstalledRoute.name,
      async (rawInput, context) => {
        requireRendererCaller(context)
        const input = cliSetLauncherInstalledRoute.input.parse(rawInput)
        return cliSetLauncherInstalledRoute.output.parse(
          await launcher.setInstalled(input.installed)
        )
      }
    ]
  ])
}
