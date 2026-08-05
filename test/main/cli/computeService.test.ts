import { describe, expect, it, vi } from 'vitest'
import { modelsInvokeRoute, type ModelInvokeEvent } from '@shared/contracts/routes'
import { ModelType } from '@shared/model'
import type { LLMCoreStreamEvent } from '@shared/types/core/llm-events'
import type { MODEL_META, ModelConfig } from '@shared/types/provider'
import { CliComputeService, type CliComputeServiceOptions } from '@/cli/computeService'
import type { CliRouteCaller } from '@/routes/routeRegistry'

const provider = {
  id: 'provider-1',
  name: 'Provider One',
  apiType: 'openai-compatible',
  apiKey: 'secret-key',
  baseUrl: 'https://private.example',
  enable: true,
  custom: true
}

const model: MODEL_META = {
  id: 'model-1',
  name: 'Model One',
  group: 'default',
  providerId: provider.id,
  type: ModelType.Chat
}

const modelConfig: ModelConfig = {
  maxTokens: 4_096,
  contextLength: 32_768,
  temperature: 0.7,
  vision: false,
  functionCall: true,
  reasoning: true,
  type: ModelType.Chat
}

const caller: CliRouteCaller = {
  kind: 'cli',
  principal: 'human',
  connectionId: 'connection-1',
  scopes: ['models:invoke']
}

async function* streamEvents(
  events: readonly LLMCoreStreamEvent[]
): AsyncGenerator<LLMCoreStreamEvent> {
  for (const event of events) yield event
}

function createService(events: readonly LLMCoreStreamEvent[]) {
  const providerSettings: CliComputeServiceOptions['providerSettings'] = {
    getProviders: vi.fn(() => [provider]),
    getProviderById: vi.fn(() => provider),
    getProviderModels: vi.fn(() => [model]),
    getCustomModels: vi.fn(() => []),
    getBatchModelStatus: vi.fn(() => ({ [model.id]: true })),
    getModelStatus: vi.fn(() => true),
    isKnownModel: vi.fn(() => true),
    getModelConfig: vi.fn(() => modelConfig)
  }
  const providerRuntime: CliComputeServiceOptions['providerRuntime'] = {
    executeWithRateLimit: vi.fn(async () => undefined),
    streamChat: vi.fn(() => streamEvents(events))
  }
  const log = { warn: vi.fn() }
  return {
    service: new CliComputeService({ providerSettings, providerRuntime, log, now: () => 100 }),
    providerSettings,
    providerRuntime,
    log
  }
}

describe('CLI compute service', () => {
  it('returns an explicitly redacted provider and model view', () => {
    const { service } = createService([])

    const result = service.listPublicProviders()

    expect(result).toEqual([
      {
        id: 'provider-1',
        name: 'Provider One',
        apiType: 'openai-compatible',
        enabled: true,
        custom: true,
        models: [
          {
            id: 'model-1',
            name: 'Model One',
            group: 'default',
            enabled: true,
            custom: false,
            vision: false,
            functionCall: false,
            reasoning: false,
            enableSearch: false,
            type: ModelType.Chat
          }
        ]
      }
    ])
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(JSON.stringify(result)).not.toContain('private.example')
  })

  it('streams only typed raw-model events and never enables tools', async () => {
    const { service, providerRuntime } = createService([
      { type: 'text', content: 'Hel' },
      { type: 'text', content: '' },
      { type: 'reasoning', reasoning_content: 'Think' },
      { type: 'text', content: 'lo' },
      {
        type: 'usage',
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      },
      { type: 'stop', stop_reason: 'complete' }
    ])
    const emitted: ModelInvokeEvent[] = []
    const signal = new AbortController().signal

    const result = await service.dispatchStream(
      modelsInvokeRoute.name,
      {
        providerId: provider.id,
        modelId: model.id,
        messages: [{ role: 'user', content: 'hello' }]
      },
      caller,
      signal,
      async (event, data) => {
        expect(event).toBe(modelsInvokeRoute.name)
        emitted.push(data as ModelInvokeEvent)
      }
    )

    expect(result).toMatchObject({
      providerId: provider.id,
      modelId: model.id,
      text: 'Hello',
      reasoning: 'Think',
      usage: { totalTokens: 5 },
      finishReason: 'complete'
    })
    expect(emitted.map((event) => event.type)).toEqual([
      'text_delta',
      'reasoning_delta',
      'text_delta',
      'usage',
      'stop'
    ])
    const streamCall = vi.mocked(providerRuntime.streamChat).mock.calls[0]
    expect(streamCall?.[6]).toEqual([])
    expect(streamCall?.[7]).toEqual({ signal })
  })

  it('does not expose provider error details through the local protocol', async () => {
    const { service, log } = createService([
      { type: 'error', error_message: 'secret upstream response' }
    ])

    await expect(
      service.dispatchStream(
        modelsInvokeRoute.name,
        {
          providerId: provider.id,
          modelId: model.id,
          messages: [{ role: 'user', content: 'hello' }]
        },
        caller,
        new AbortController().signal,
        async () => undefined
      )
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Model provider request failed',
      retriable: true
    })
    expect(log.warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret upstream response')
  })

  it('rejects tool events instead of turning raw invocation into an Agent run', async () => {
    const { service } = createService([
      { type: 'tool_call_start', tool_call_id: 'call-1', tool_call_name: 'dangerous_tool' }
    ])

    await expect(
      service.dispatchStream(
        modelsInvokeRoute.name,
        {
          providerId: provider.id,
          modelId: model.id,
          messages: [{ role: 'user', content: 'hello' }]
        },
        caller,
        new AbortController().signal,
        async () => undefined
      )
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Raw model invocation returned an unsupported event'
    })
  })
})
