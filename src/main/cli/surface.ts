import type { RouteContract } from '@shared/contracts/contract'
import {
  artifactsDeleteRoute,
  artifactsDescribeRoute,
  artifactsReadRoute,
  cliCapabilitiesRoute,
  cliDoctorRoute,
  cliStatusRoute,
  cliVersionRoute,
  imagesGenerateRoute,
  modelsInvokeRoute,
  providersListPublicRoute,
  speechGenerateRoute,
  videosGenerateRoute,
  type CliCapability
} from '@shared/contracts/routes'
import {
  LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS,
  type LocalControlEffect,
  type LocalControlPrincipal,
  type LocalControlScope
} from '@shared/contracts/localControl'

export type LocalControlTransport = 'rpc' | 'stream' | 'upload' | 'download'
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

const mediaEntry = (contract: RouteContract): CliSurfaceEntry => ({
  contract,
  effect: 'compute',
  callers: ['human', 'agent'],
  scopes: ['media:generate'],
  transport: 'stream',
  approval: 'never',
  limits: {
    maxBodyBytes: 512 * 1024,
    timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS
  }
})

const CLI_SURFACE_V1_ENTRIES = [
  {
    contract: modelsInvokeRoute,
    effect: 'compute',
    callers: ['human', 'agent'],
    scopes: ['models:invoke'],
    transport: 'stream',
    approval: 'never',
    limits: { maxBodyBytes: 5 * 1024 * 1024, timeoutMs: LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS }
  },
  mediaEntry(imagesGenerateRoute),
  mediaEntry(videosGenerateRoute),
  mediaEntry(speechGenerateRoute),
  {
    contract: providersListPublicRoute,
    effect: 'read',
    callers: ['human', 'agent'],
    scopes: ['providers:read'],
    transport: 'rpc',
    approval: 'never',
    limits: DIAGNOSTIC_LIMITS
  },
  {
    contract: artifactsDescribeRoute,
    effect: 'read',
    callers: ['human', 'agent'],
    scopes: ['artifacts:read'],
    transport: 'rpc',
    approval: 'never',
    limits: DIAGNOSTIC_LIMITS
  },
  {
    contract: artifactsReadRoute,
    effect: 'read',
    callers: ['human'],
    scopes: ['artifacts:read'],
    transport: 'download',
    approval: 'never',
    limits: { maxBodyBytes: 1, timeoutMs: 5 * 60_000 }
  },
  {
    contract: artifactsDeleteRoute,
    effect: 'local-maintenance',
    callers: ['human'],
    scopes: ['artifacts:manage'],
    transport: 'rpc',
    approval: 'never',
    limits: DIAGNOSTIC_LIMITS
  },
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
