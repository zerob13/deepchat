import type { RouteContract } from '@shared/contracts/contract'
import {
  cliCapabilitiesRoute,
  cliDoctorRoute,
  cliStatusRoute,
  cliVersionRoute,
  type CliCapability
} from '@shared/contracts/routes'
import type {
  LocalControlEffect,
  LocalControlPrincipal,
  LocalControlScope
} from '@shared/contracts/localControl'

export type LocalControlTransport = 'rpc' | 'stream' | 'upload'
export type LocalControlApprovalMode = 'never' | 'policy'

export type CliRouteLimits = Readonly<{
  maxBodyBytes: number
  timeoutMs: number
}>

export type CliSurfaceEntry = Readonly<{
  contract: RouteContract
  effect: LocalControlEffect
  callers: readonly LocalControlPrincipal[]
  scopes: readonly LocalControlScope[]
  transport: LocalControlTransport
  approval: LocalControlApprovalMode
  limits: CliRouteLimits
}>

const DIAGNOSTIC_LIMITS = {
  maxBodyBytes: 16 * 1024,
  timeoutMs: 5_000
} as const satisfies CliRouteLimits

const diagnosticEntry = (contract: RouteContract): CliSurfaceEntry => ({
  contract,
  effect: 'read',
  callers: ['human', 'agent'],
  scopes: ['system:read'],
  transport: 'rpc',
  approval: 'never',
  limits: DIAGNOSTIC_LIMITS
})

const CLI_SURFACE_V1_ENTRIES = [
  diagnosticEntry(cliStatusRoute),
  diagnosticEntry(cliVersionRoute),
  diagnosticEntry(cliCapabilitiesRoute),
  diagnosticEntry(cliDoctorRoute)
] as const

function createSurfaceRegistry(
  entries: readonly CliSurfaceEntry[]
): ReadonlyMap<string, CliSurfaceEntry> {
  const registry = new Map<string, CliSurfaceEntry>()
  for (const entry of entries) {
    if (registry.has(entry.contract.name)) {
      throw new Error(`Duplicate CLI surface method: ${entry.contract.name}`)
    }
    registry.set(entry.contract.name, entry)
  }
  return registry
}

export const CLI_SURFACE_V1 = createSurfaceRegistry(CLI_SURFACE_V1_ENTRIES)

export function getCliSurfaceEntry(method: string): CliSurfaceEntry | undefined {
  return CLI_SURFACE_V1.get(method)
}

export function listCliSurfaceCapabilities(): CliCapability[] {
  return Array.from(CLI_SURFACE_V1.values(), (entry) => ({
    method: entry.contract.name,
    effect: entry.effect,
    callers: [...entry.callers],
    scopes: [...entry.scopes],
    transport: entry.transport,
    approval: entry.approval,
    maxBodyBytes: entry.limits.maxBodyBytes,
    timeoutMs: entry.limits.timeoutMs
  })).sort((left, right) => left.method.localeCompare(right.method))
}
