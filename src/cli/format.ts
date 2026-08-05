import type { JsonValue } from '@shared/contracts/json'
import type { LocalControlRpcResponse } from '@shared/contracts/localControl'
import type { CliRpcContract } from './args'
import { CLI_VERSION } from './transport'

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`
  const seconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return [hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : '', `${remainder}s`]
    .filter(Boolean)
    .join(' ')
}

export function formatHumanResult(
  contract: CliRpcContract,
  value: JsonValue,
  context: { outputPath?: string } = {}
): string {
  switch (contract.name) {
    case 'cli.status': {
      const result = contract.output.parse(value)
      return [
        result.running ? 'DeepChat is running' : 'DeepChat is stopped',
        `PID: ${result.pid}`,
        `Uptime: ${formatDuration(result.uptimeMs)}`,
        `Endpoint: ${result.endpointKind}`,
        `Connections: ${result.activeConnections}`,
        `Pending requests: ${result.pendingRequests}`
      ].join('\n')
    }
    case 'cli.version': {
      const result = contract.output.parse(value)
      return [
        `DeepChat ${result.appVersion}`,
        `CLI ${CLI_VERSION}`,
        `Protocol ${result.protocolVersion}, surface ${result.surfaceVersion}`
      ].join('\n')
    }
    case 'cli.capabilities': {
      const result = contract.output.parse(value)
      return [
        `CLI surface ${result.surfaceVersion} (${result.capabilities.length} methods)`,
        ...result.capabilities.map(
          (capability) =>
            `${capability.method}  ${capability.effect}  ${capability.callers.join(',')}  ${capability.transport}`
        )
      ].join('\n')
    }
    case 'cli.doctor': {
      const result = contract.output.parse(value)
      return [
        `DeepChat CLI doctor: ${result.healthy ? 'healthy' : 'unhealthy'}`,
        ...result.checks.map(
          (check) => `[${check.status.toUpperCase()}] ${check.id}: ${check.message}`
        )
      ].join('\n')
    }
    case 'artifacts.describe': {
      const { artifact } = contract.output.parse(value)
      return [
        `${artifact.id}  ${artifact.mimeType}  ${artifact.size} bytes`,
        `SHA-256: ${artifact.sha256}`,
        `Expires: ${new Date(artifact.expiresAt).toISOString()}`
      ].join('\n')
    }
    case 'artifacts.read': {
      const { artifact } = contract.output.parse(value)
      return `Saved ${artifact.size} bytes to ${context.outputPath ?? artifact.filename}`
    }
    case 'artifacts.delete': {
      contract.output.parse(value)
      return 'Artifact deleted'
    }
    case 'providers.listPublic': {
      const result = contract.output.parse(value)
      return result.providers
        .flatMap((provider) => [
          `${provider.id}  ${provider.enabled ? 'enabled' : 'disabled'}  ${provider.name}`,
          ...provider.models.map(
            (model) =>
              `  ${model.id}  ${model.enabled ? 'enabled' : 'disabled'}  ${model.type ?? 'chat'}`
          )
        ])
        .join('\n')
    }
    case 'models.invoke': {
      return contract.output.parse(value).text
    }
  }
}

export function serializeMachineResponse(response: LocalControlRpcResponse): string {
  return `${JSON.stringify(response)}\n`
}
