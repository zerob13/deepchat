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
            `${capability.method}  ${capability.possibleEffects.join(',')}  ${capability.callers.join(',')}  ${capability.transport}`
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
          `${provider.id}  ${provider.enabled ? 'enabled' : 'disabled'}  ${provider.storedCredentialConfigured ? 'credential-stored' : 'no-stored-credential'}  ${provider.name}`,
          ...provider.models.map(
            (model) =>
              `  ${model.id}  ${model.enabled ? 'enabled' : 'disabled'}  ${model.type ?? 'chat'}`
          )
        ])
        .join('\n')
    }
    case 'providers.testPublicConnection': {
      const result = contract.output.parse(value)
      return result.isOk
        ? 'Provider connection succeeded'
        : `Provider connection failed: ${result.errorMsg}`
    }
    case 'providers.addPublic':
    case 'providers.updatePublic': {
      const result = contract.output.parse(value)
      return `${result.provider.id}  ${result.provider.enabled ? 'enabled' : 'disabled'}  ${result.provider.name}`
    }
    case 'providers.setCredential': {
      const result = contract.output.parse(value)
      return result.action === 'set'
        ? `Stored ${result.kind} credential for ${result.providerId}`
        : `Cleared ${result.kind} credential for ${result.providerId}`
    }
    case 'providers.remove': {
      const result = contract.output.parse(value)
      return result.removed ? 'Provider removed' : 'Provider was not found'
    }
    case 'models.listRuntime': {
      const result = contract.output.parse(value)
      return result.models
        .map((model) => `${model.id}  ${model.enabled ? 'enabled' : 'disabled'}  ${model.name}`)
        .join('\n')
    }
    case 'models.getPublicConfig':
    case 'models.setPublicConfig': {
      return JSON.stringify(contract.output.parse(value).config, null, 2)
    }
    case 'models.setStatus': {
      const result = contract.output.parse(value)
      return `${result.modelId} ${result.enabled ? 'enabled' : 'disabled'}`
    }
    case 'models.resetConfig': {
      contract.output.parse(value)
      return 'Model configuration reset'
    }
    case 'settings.getPublic': {
      const result = contract.output.parse(value)
      return Object.entries(result.values)
        .map(([key, setting]) => `${key} = ${JSON.stringify(setting)}`)
        .join('\n')
    }
    case 'settings.updatePublic': {
      const result = contract.output.parse(value)
      return result.changedKeys
        .map((key) => `${key} = ${JSON.stringify(result.values[key])}`)
        .join('\n')
    }
    case 'models.invoke': {
      return contract.output.parse(value).text
    }
    case 'audio.transcribeUpload':
    case 'audio.transcribeArtifact': {
      return contract.output.parse(value).text
    }
    case 'ocr.getRuntimeStatus': {
      const result = contract.output.parse(value)
      const availability =
        result.availability.status === 'available'
          ? `available (${result.availability.lightOcrVersion})`
          : `unavailable (${result.availability.reason})`
      return [
        `OCR: ${availability}`,
        `Platform: ${result.platform}/${result.arch}`,
        `Runtime: ${result.process?.state ?? 'not started'}`,
        `Cache: ${result.cache ? `${result.cache.entryCount} entries, ${result.cache.logicalBytes} bytes` : 'not initialized'}`
      ].join('\n')
    }
    case 'ocr.extractUpload':
    case 'ocr.extractArtifact': {
      return contract.output.parse(value).text
    }
    case 'ocr.clearCache': {
      const result = contract.output.parse(value)
      return `OCR cache cleared (${result.cache.entryCount} entries, ${result.cache.logicalBytes} bytes)`
    }
    case 'images.generate':
    case 'videos.generate':
    case 'speech.generate': {
      const result = contract.output.parse(value)
      const noun =
        contract.name === 'images.generate'
          ? 'image'
          : contract.name === 'videos.generate'
            ? 'video'
            : 'audio'
      return [
        `Generated ${result.artifacts.length} ${noun} artifact${result.artifacts.length === 1 ? '' : 's'} in ${formatDuration(result.durationMs)}`,
        ...result.artifacts.flatMap((artifact) => [
          `${artifact.id}  ${artifact.mimeType}  ${artifact.size} bytes  ${artifact.filename}`,
          `  Download: deepchat artifact get --id ${artifact.id} --out ${artifact.filename}`
        ])
      ].join('\n')
    }
  }
}

export function serializeMachineResponse(response: LocalControlRpcResponse): string {
  return `${JSON.stringify(response)}\n`
}
