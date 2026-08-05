import { approvalsResolveRoute } from '@shared/contracts/routes'
import { createRouteMap, requireRendererCaller } from '@/routes/routeRegistry'

export type ApprovalRoutesDependencies = Readonly<{
  resolve(
    input: { requestId: string; decision: 'approved' | 'denied' },
    caller: ReturnType<typeof requireRendererCaller>
  ): boolean
}>

export function createApprovalRoutes(dependencies: ApprovalRoutesDependencies) {
  return createRouteMap([
    [
      approvalsResolveRoute.name,
      async (rawInput, context) => {
        const input = approvalsResolveRoute.input.parse(rawInput)
        const caller = requireRendererCaller(context)
        return approvalsResolveRoute.output.parse({
          accepted: dependencies.resolve(input, caller)
        })
      }
    ]
  ])
}
