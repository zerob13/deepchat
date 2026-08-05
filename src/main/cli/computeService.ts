import {
  MODEL_INVOKE_MAX_OUTPUT_CHARACTERS,
  ModelInvokeEventSchema,
  PublicProviderSchema,
  modelsInvokeRoute,
  providersListPublicRoute,
  type ModelInvokeEvent,
  type ModelInvokeInput,
  type ModelInvokeOutput,
  type PublicProvider
} from '@shared/contracts/routes'
import type { JsonValue } from '@shared/contracts/json'
import { ModelType } from '@shared/model'
import type { LLMCoreStreamEvent, ProviderRoundStopReason } from '@shared/types/core/llm-events'
import type { ProviderSettingsPort } from '@/provider/settings'
import type { ProviderRuntime } from '@/provider'
import {
  createRouteMap,
  type CliRouteCaller,
  type DeepchatRouteMap,
  type RouteCaller
} from '@/routes/routeRegistry'
import { CliRequestError } from './errors'

const MAX_STREAM_DELTA_CHARACTERS = 1024 * 1024
const MAX_MODEL_STREAM_EVENTS = 10_000
const MAX_PUBLIC_PROVIDERS = 1_000
const MAX_PUBLIC_MODELS = 10_000

type ComputeEmitter = (event: string, data: JsonValue) => Promise<void>

type ComputeProviderSettings = Pick<
  ProviderSettingsPort,
  | 'getProviders'
  | 'getProviderById'
  | 'getProviderModels'
  | 'getCustomModels'
  | 'getBatchModelStatus'
  | 'getModelStatus'
  | 'isKnownModel'
  | 'getModelConfig'
>

type ComputeProviderRuntime = Pick<ProviderRuntime, 'executeWithRateLimit' | 'streamChat'>

export type CliComputeServiceOptions = Readonly<{
  providerSettings: ComputeProviderSettings
  providerRuntime: ComputeProviderRuntime
  now?: () => number
  log?: Pick<Console, 'warn'>
}>

function requireCliCaller(caller: RouteCaller): CliRouteCaller {
  if (caller.kind !== 'cli') {
    throw new CliRequestError('permission_denied', 'Compute routes require a CLI caller', {
      httpStatus: 403
    })
  }
  return caller
}

function splitStreamDelta(value: string): string[] {
  if (value.length === 0) return []
  if (value.length <= MAX_STREAM_DELTA_CHARACTERS) return [value]
  const chunks: string[] = []
  let offset = 0
  while (offset < value.length) {
    let end = Math.min(value.length, offset + MAX_STREAM_DELTA_CHARACTERS)
    const lastCodeUnit = value.charCodeAt(end - 1)
    if (end < value.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1
    chunks.push(value.slice(offset, end))
    offset = end
  }
  return chunks
}

function toUsage(event: Extract<LLMCoreStreamEvent, { type: 'usage' }>): ModelInvokeEvent {
  return ModelInvokeEventSchema.parse({
    type: 'usage',
    usage: {
      promptTokens: event.usage.prompt_tokens,
      completionTokens: event.usage.completion_tokens,
      totalTokens: event.usage.total_tokens,
      ...(event.usage.cached_tokens !== undefined
        ? { cachedTokens: event.usage.cached_tokens }
        : {}),
      ...(event.usage.cache_write_tokens !== undefined
        ? { cacheWriteTokens: event.usage.cache_write_tokens }
        : {})
    }
  })
}

export class CliComputeService {
  private readonly now: () => number
  private readonly log: Pick<Console, 'warn'>

  constructor(private readonly options: CliComputeServiceOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? console
  }

  listPublicProviders(enabledOnly = false): PublicProvider[] {
    const providers = this.options.providerSettings
      .getProviders()
      .filter((provider) => !enabledOnly || provider.enable)
    if (providers.length > MAX_PUBLIC_PROVIDERS) {
      throw new CliRequestError('result_too_large', 'Provider list exceeds the public limit', {
        httpStatus: 413
      })
    }

    let totalModels = 0
    return providers.map((provider) => {
      const modelsById = new Map(
        [
          ...this.options.providerSettings.getProviderModels(provider.id),
          ...this.options.providerSettings.getCustomModels(provider.id)
        ].map((model) => [model.id, model] as const)
      )
      totalModels += modelsById.size
      if (totalModels > MAX_PUBLIC_MODELS) {
        throw new CliRequestError('result_too_large', 'Model list exceeds the public limit', {
          httpStatus: 413
        })
      }
      const status = this.options.providerSettings.getBatchModelStatus(
        provider.id,
        Array.from(modelsById.keys())
      )
      const models = Array.from(modelsById.values())
        .map((model) => ({
          id: model.id,
          name: model.name,
          group: model.group,
          enabled: status[model.id] ?? false,
          custom: model.isCustom === true,
          vision: model.vision === true,
          functionCall: model.functionCall === true,
          reasoning: model.reasoning === true,
          enableSearch: model.enableSearch === true,
          ...(model.type ? { type: model.type } : {}),
          ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
          ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {})
        }))
        .filter((model) => !enabledOnly || model.enabled)

      return PublicProviderSchema.parse({
        id: provider.id,
        name: provider.name || provider.id,
        apiType: provider.apiType,
        enabled: provider.enable,
        custom: provider.custom === true,
        models
      })
    })
  }

  async dispatchStream(
    method: string,
    rawInput: unknown,
    _caller: CliRouteCaller,
    signal: AbortSignal,
    emit: ComputeEmitter
  ): Promise<unknown> {
    if (method !== modelsInvokeRoute.name) {
      throw new CliRequestError('not_found', 'Streaming method is not implemented', {
        httpStatus: 404
      })
    }
    return await this.invokeModel(modelsInvokeRoute.input.parse(rawInput), signal, emit)
  }

  private async invokeModel(
    input: ModelInvokeInput,
    signal: AbortSignal,
    emit: ComputeEmitter
  ): Promise<ModelInvokeOutput> {
    const startedAt = this.now()
    let providerError: unknown
    let emittedEvents = 0
    const emitEvent = async (event: ModelInvokeEvent): Promise<void> => {
      if (emittedEvents >= MAX_MODEL_STREAM_EVENTS) {
        throw new CliRequestError('result_too_large', 'Model stream exceeds the event limit', {
          httpStatus: 413
        })
      }
      emittedEvents += 1
      await emit(modelsInvokeRoute.name, event)
    }
    try {
      signal.throwIfAborted()
      const provider = this.options.providerSettings.getProviderById(input.providerId)
      if (!provider?.enable) {
        throw new CliRequestError('not_found', 'Provider is not available', { httpStatus: 404 })
      }
      if (!this.options.providerSettings.isKnownModel(input.providerId, input.modelId)) {
        throw new CliRequestError('not_found', 'Model is not available', { httpStatus: 404 })
      }
      if (!this.options.providerSettings.getModelStatus(input.providerId, input.modelId)) {
        throw new CliRequestError('conflict', 'Model is disabled', { httpStatus: 409 })
      }

      const modelConfig = this.options.providerSettings.getModelConfig(
        input.modelId,
        input.providerId
      )
      if (modelConfig.type !== ModelType.Chat) {
        throw new CliRequestError('conflict', 'Model is not configured for raw text invocation', {
          httpStatus: 409
        })
      }

      let queuedEmission = Promise.resolve()
      let queuedEmissionError: unknown
      await this.options.providerRuntime.executeWithRateLimit(input.providerId, {
        signal,
        onQueued: (snapshot) => {
          const event = ModelInvokeEventSchema.parse({
            type: 'rate_limit',
            providerId: snapshot.providerId,
            qpsLimit: snapshot.qpsLimit,
            currentQps: snapshot.currentQps,
            queueLength: snapshot.queueLength,
            estimatedWaitTimeMs: snapshot.estimatedWaitTime
          })
          queuedEmission = emitEvent(event).catch((error) => {
            queuedEmissionError = error
          })
        }
      })
      await queuedEmission
      if (queuedEmissionError) throw queuedEmissionError

      const stream = this.options.providerRuntime.streamChat(
        input.providerId,
        input.messages,
        input.modelId,
        modelConfig,
        input.temperature ?? modelConfig.temperature ?? 0.7,
        input.maxTokens ?? modelConfig.maxTokens,
        [],
        { signal }
      )
      const textChunks: string[] = []
      const reasoningChunks: string[] = []
      let outputCharacters = 0
      let usage: ModelInvokeOutput['usage']
      let finishReason: ProviderRoundStopReason | undefined
      let firstTokenAt: number | undefined

      for await (const event of stream) {
        signal.throwIfAborted()
        switch (event.type) {
          case 'text':
          case 'reasoning': {
            const delta = event.type === 'text' ? event.content : event.reasoning_content
            outputCharacters += delta.length
            if (outputCharacters > MODEL_INVOKE_MAX_OUTPUT_CHARACTERS) {
              throw new CliRequestError('result_too_large', 'Model output exceeds the text limit', {
                httpStatus: 413
              })
            }
            if (firstTokenAt === undefined && delta.length > 0) firstTokenAt = this.now()
            if (event.type === 'text') textChunks.push(delta)
            else reasoningChunks.push(delta)
            for (const chunk of splitStreamDelta(delta)) {
              await emitEvent(
                ModelInvokeEventSchema.parse({
                  type: event.type === 'text' ? 'text_delta' : 'reasoning_delta',
                  text: chunk
                })
              )
            }
            break
          }
          case 'usage': {
            const usageEvent = toUsage(event)
            usage = usageEvent.type === 'usage' ? usageEvent.usage : undefined
            await emitEvent(usageEvent)
            break
          }
          case 'rate_limit':
            await emitEvent(
              ModelInvokeEventSchema.parse({
                type: 'rate_limit',
                providerId: event.rate_limit.providerId,
                qpsLimit: event.rate_limit.qpsLimit,
                currentQps: event.rate_limit.currentQps,
                queueLength: event.rate_limit.queueLength,
                ...(event.rate_limit.estimatedWaitTime !== undefined
                  ? { estimatedWaitTimeMs: event.rate_limit.estimatedWaitTime }
                  : {})
              })
            )
            break
          case 'stop':
            finishReason = event.stop_reason
            await emitEvent(
              ModelInvokeEventSchema.parse({ type: 'stop', reason: event.stop_reason })
            )
            break
          case 'error':
            providerError = event
            throw new Error('Provider returned an error event')
          case 'tool_call_start':
          case 'tool_call_chunk':
          case 'tool_call_end':
          case 'permission':
          case 'plan':
          case 'image_data':
            throw new CliRequestError(
              'conflict',
              'Raw model invocation returned an unsupported event',
              { httpStatus: 409 }
            )
        }
      }

      if (!finishReason) {
        throw new Error('Provider stream ended without a stop event')
      }
      if (finishReason === 'error') {
        throw new Error('Provider stream stopped with an error')
      }
      const text = textChunks.join('')
      const reasoning = reasoningChunks.join('')
      return modelsInvokeRoute.output.parse({
        providerId: input.providerId,
        modelId: input.modelId,
        text,
        ...(reasoning ? { reasoning } : {}),
        ...(usage ? { usage } : {}),
        finishReason,
        durationMs: Math.max(0, this.now() - startedAt),
        ttftMs: firstTokenAt === undefined ? null : Math.max(0, firstTokenAt - startedAt)
      })
    } catch (error) {
      if (error instanceof CliRequestError) throw error
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new CliRequestError('cancelled', 'Model invocation was cancelled', {
          retriable: true
        })
      }
      this.log.warn('[CLI] Model invocation failed', {
        providerId: input.providerId,
        modelId: input.modelId,
        failure:
          providerError && typeof providerError === 'object' && 'failure' in providerError
            ? providerError.failure
            : { name: error instanceof Error ? error.name : typeof error }
      })
      throw new CliRequestError('unavailable', 'Model provider request failed', {
        httpStatus: 503,
        retriable: true
      })
    }
  }
}

export function createCliComputeRoutes(service: CliComputeService): DeepchatRouteMap {
  return createRouteMap([
    [
      providersListPublicRoute.name,
      async (rawInput, context) => {
        requireCliCaller(context.caller)
        const input = providersListPublicRoute.input.parse(rawInput)
        return providersListPublicRoute.output.parse({
          providers: service.listPublicProviders(input.enabledOnly ?? false)
        })
      }
    ]
  ])
}
