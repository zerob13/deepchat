import type { ProviderModelResolutionPort } from '@/provider/settings'
import { DeepChatAgentRuntime } from '@/agent/deepchat/instance/deepChatAgentRuntime'
import type { DeepChatAgentInstance } from '@/agent/deepchat/instance/deepChatAgentInstance'
import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import {
  CompactionRuntimeCoordinator,
  type CompactionRuntimeCoordinatorDependencies
} from '@/agent/deepchat/runtime/compactionRuntimeCoordinator'
import type { CompactionIntent } from '@/agent/deepchat/runtime/compactionService'
import type {
  DeepChatSessionState,
  SessionGenerationSettings
} from '@shared/types/agent-interface'
import { ModelType } from '@shared/model'
import { afterEach, describe, expect, it, vi } from 'vitest'

const SESSION_ID = 'session'

const createDelegate = () => ({
  send: vi.fn().mockResolvedValue({ requestId: 'request', messageId: 'message' }),
  cancel: vi.fn().mockResolvedValue(undefined),
  snapshot: vi.fn().mockResolvedValue({ status: 'idle' }),
  close: vi.fn().mockResolvedValue(undefined)
})

function createRuntimeState(
  status: DeepChatSessionState['status'] = 'idle'
): DeepChatSessionState {
  return {
    status,
    providerId: 'openai',
    modelId: 'gpt-5',
    permissionMode: 'full_access'
  }
}

function createGenerationSettings(): SessionGenerationSettings {
  return {
    systemPrompt: 'System prompt',
    temperature: 0.7,
    contextLength: 128_000,
    maxTokens: 4096,
    timeout: 30_000
  }
}

function createProviderSettings(): ProviderModelResolutionPort {
  return {
    getProviderById: vi.fn().mockReturnValue(undefined),
    isKnownModel: vi.fn().mockReturnValue(true),
    getModelConfig: vi.fn().mockReturnValue({
      maxTokens: 4096,
      contextLength: 128_000,
      vision: false,
      functionCall: true,
      reasoning: true,
      type: ModelType.Chat
    }),
    getCapabilityProviderId: vi.fn((providerId: string) => providerId),
    supportsReasoningCapability: vi.fn().mockReturnValue(true),
    getReasoningPortrait: vi.fn().mockReturnValue(null),
    getThinkingBudgetRange: vi.fn().mockReturnValue({}),
    supportsAudioInputCapability: vi.fn().mockReturnValue(false),
    supportsReasoningEffortCapability: vi.fn().mockReturnValue(false),
    getReasoningEffortDefault: vi.fn().mockReturnValue(undefined),
    supportsVerbosityCapability: vi.fn().mockReturnValue(false),
    getVerbosityDefault: vi.fn().mockReturnValue(undefined)
  }
}

function createIntent(previousSummaryUpdatedAt: number | null = null): CompactionIntent {
  return {
    sessionId: SESSION_ID,
    previousState: {
      summaryText: previousSummaryUpdatedAt === null ? null : 'Previous summary',
      summaryCursorOrderSeq: previousSummaryUpdatedAt === null ? 1 : 3,
      summaryUpdatedAt: previousSummaryUpdatedAt
    },
    targetCursorOrderSeq: 5,
    summaryBlocks: ['Summarize this history'],
    currentModel: {
      providerId: 'openai',
      modelId: 'gpt-5',
      contextLength: 128_000
    },
    reserveTokens: 4096,
    retainedTurnCount: 0,
    retainedTokenEstimate: 0,
    retainedTokenTarget: 0
  }
}

type PrepareManualCompactionInput = Parameters<
  CompactionRuntimeCoordinatorDependencies['compactionService']['prepareForManualCompaction']
>[0]

function createHarness(options?: {
  hydrate?: boolean
  sessionExists?: boolean
  state?: DeepChatSessionState
}) {
  const runtime = new DeepChatAgentRuntime(() => createDelegate())
  const shouldHydrate = options?.hydrate !== false
  const initialInstance = shouldHydrate
    ? runtime.getOrHydrate(toAppSessionId(SESSION_ID))
    : undefined
  if (initialInstance && options?.state !== undefined) {
    initialInstance.setRuntimeState(options.state)
  } else if (initialInstance) {
    initialInstance.setRuntimeState(createRuntimeState())
  }

  let summaryState = {
    summaryText: null as string | null,
    summaryCursorOrderSeq: 1,
    summaryUpdatedAt: null as number | null
  }
  const publishedEvents: Array<{ event: string; payload: unknown }> = []
  const messageStore: CompactionRuntimeCoordinatorDependencies['messageStore'] = {
    createCompactionMessage: vi.fn().mockReturnValue('compaction-message'),
    createCompactionMessageAtOrderSeq: vi.fn().mockReturnValue('compaction-message'),
    deleteMessage: vi.fn(),
    getMessages: vi.fn().mockReturnValue([]),
    getNextOrderSeq: vi.fn().mockReturnValue(7),
    updateCompactionMessage: vi.fn()
  }
  const sessionStore: CompactionRuntimeCoordinatorDependencies['sessionStore'] = {
    get: vi.fn().mockImplementation(() =>
      options?.sessionExists === true
        ? {
            provider_id: 'openai',
            model_id: 'gpt-5',
            permission_mode: 'full_access'
          }
        : undefined
    ),
    getSummaryState: vi.fn(() => ({ ...summaryState })),
    resetSummaryState: vi.fn(() => {
      summaryState = {
        summaryText: null,
        summaryCursorOrderSeq: 1,
        summaryUpdatedAt: null
      }
    })
  }

  const scopeFor = vi.fn((sessionId: string, instance: DeepChatAgentInstance) =>
    runtime.scopeFor(toAppSessionId(sessionId), instance)
  )
  const transitionStatus = vi.fn(
    (
      scope: ReturnType<typeof runtime.scopeFor>,
      status: DeepChatSessionState['status']
    ): boolean => {
      if (!scope.isCurrent()) return false
      const state = scope.state()
      if (!state) return false
      state.status = status
      return true
    }
  )
  const ensureOperationController = vi.fn((scope: ReturnType<typeof runtime.scopeFor>) => {
    scope.assertCurrent()
    const controller = new AbortController()
    scope.instance.setAbortController(controller)
    return controller
  })
  const canSettleOperation = vi.fn(
    (scope: ReturnType<typeof runtime.scopeFor>, controller: AbortController) =>
      scope.isCurrent() && scope.instance.getAbortController() === controller
  )
  const clearOperationController = vi.fn(
    (scope: ReturnType<typeof runtime.scopeFor>, controller?: AbortController) =>
      scope.isCurrent() && scope.instance.clearAbortController(controller)
  )
  const runLifecycle: CompactionRuntimeCoordinatorDependencies['runLifecycle'] = {
    canSettleOperation,
    clearOperationController,
    ensureOperationController,
    hasPendingInteractions: vi.fn().mockReturnValue(false),
    scopeFor,
    transitionStatus
  }

  const generationSettings = createGenerationSettings()
  const sessionSettings: CompactionRuntimeCoordinatorDependencies['sessionSettings'] = {
    getEffectiveGenerationSettings: vi.fn().mockResolvedValue(generationSettings),
    resolveProjectDir: vi.fn().mockReturnValue('/workspace')
  }
  const toolResolver: CompactionRuntimeCoordinatorDependencies['toolResolver'] = {
    loadToolDefinitionsForSession: vi.fn().mockResolvedValue([]),
    resolveActiveSkillNamesForToolProfile: vi.fn().mockResolvedValue([])
  }
  const prepareForManualCompaction = vi.fn(
    async (_input: PrepareManualCompactionInput): Promise<CompactionIntent | null> => null
  )
  const applyCompaction = vi.fn(
    async (intent: CompactionIntent) => {
      summaryState = {
        summaryText: 'Updated summary',
        summaryCursorOrderSeq: intent.targetCursorOrderSeq,
        summaryUpdatedAt: (intent.previousState.summaryUpdatedAt ?? 0) + 1
      }
      return {
        succeeded: true as const,
        summaryState: { ...summaryState }
      }
    }
  )
  const compactionService: CompactionRuntimeCoordinatorDependencies['compactionService'] = {
    applyCompaction,
    prepareForManualCompaction
  }
  const emitMessageRefresh = vi.fn()
  const getInstance = vi.fn((sessionId: string) =>
    runtime.getOrHydrate(toAppSessionId(sessionId))
  )
  const getHydratedInstance = vi.fn((sessionId: string) =>
    runtime.getHydrated(toAppSessionId(sessionId))
  )
  const getSessionListState = vi.fn(async () => initialInstance?.getRuntimeState() ?? null)
  const deps: CompactionRuntimeCoordinatorDependencies = {
    compactionService,
    sessionStore,
    messageStore,
    providerSettings: createProviderSettings(),
    toolResolver,
    runLifecycle,
    sessionSettings,
    tapeReconciliation: {
      ensureSessionTapeReady: vi.fn().mockReturnValue({
        sessionId: SESSION_ID,
        migrationState: 'ready',
        messageCount: 0,
        maxOrderSeq: 0,
        appendedFactCount: 0,
        historyRecords: []
      })
    },
    getInstance,
    getHydratedInstance,
    getSessionListState,
    assertCurrent: (sessionId, instance) =>
      runtime.scopeFor(toAppSessionId(sessionId), instance).assertCurrent(),
    createBasePromptAssembler: () => ({
      assemble: vi.fn().mockResolvedValue('Assembled system prompt')
    }),
    emitMessageRefresh,
    publishEvent: (event, payload) => publishedEvents.push({ event, payload })
  }
  const coordinator = new CompactionRuntimeCoordinator(deps)

  return {
    applyCompaction,
    canSettleOperation,
    clearOperationController,
    coordinator,
    emitMessageRefresh,
    getHydratedInstance,
    getInstance,
    initialInstance,
    messageStore,
    prepareForManualCompaction,
    publishedEvents,
    runtime,
    sessionSettings,
    sessionStore,
    setSummaryState: (next: typeof summaryState) => {
      summaryState = next
    },
    toolResolver,
    transitionStatus
  }
}

describe('CompactionRuntimeCoordinator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not hydrate an instance when neither runtime nor persisted session facts exist', async () => {
    const { coordinator, getInstance, runtime } = createHarness({ hydrate: false })

    await expect(coordinator.getState(SESSION_ID)).rejects.toThrow(
      `Session ${SESSION_ID} not found`
    )

    expect(getInstance).not.toHaveBeenCalled()
    expect(runtime.getHydrated(toAppSessionId(SESSION_ID))).toBeUndefined()
  })

  it('keeps an in-flight state authoritative and otherwise refreshes from persisted summary', async () => {
    const { coordinator, initialInstance, setSummaryState } = createHarness()
    setSummaryState({
      summaryText: 'Persisted summary',
      summaryCursorOrderSeq: 7,
      summaryUpdatedAt: 200
    })
    initialInstance?.setCompactionState({
      status: 'compacting',
      cursorOrderSeq: 9,
      summaryUpdatedAt: 100
    })

    await expect(coordinator.getState(SESSION_ID)).resolves.toEqual({
      status: 'compacting',
      cursorOrderSeq: 9,
      summaryUpdatedAt: 100
    })

    initialInstance?.setCompactionState({
      status: 'idle',
      cursorOrderSeq: 1,
      summaryUpdatedAt: null
    })
    await expect(coordinator.getState(SESSION_ID)).resolves.toEqual({
      status: 'compacted',
      cursorOrderSeq: 7,
      summaryUpdatedAt: 200
    })
  })

  it('owns the complete manual lifecycle when no history is eligible', async () => {
    const {
      coordinator,
      initialInstance,
      prepareForManualCompaction,
      sessionSettings,
      toolResolver,
      transitionStatus
    } = createHarness()

    await expect(coordinator.compact(SESSION_ID)).resolves.toEqual({
      compacted: false,
      state: { status: 'idle', cursorOrderSeq: 1, summaryUpdatedAt: null }
    })

    expect(transitionStatus.mock.calls.map(([, status]) => status)).toEqual([
      'generating',
      'idle'
    ])
    expect(initialInstance?.getAbortController()).toBeUndefined()
    expect(sessionSettings.getEffectiveGenerationSettings).toHaveBeenCalledWith(
      SESSION_ID,
      initialInstance
    )
    expect(toolResolver.loadToolDefinitionsForSession).toHaveBeenCalledWith(
      SESSION_ID,
      '/workspace',
      [],
      initialInstance
    )
    expect(prepareForManualCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        providerId: 'openai',
        modelId: 'gpt-5',
        systemPrompt: 'Assembled system prompt',
        reserveTokens: 4096,
        historyRecords: [],
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('applies a prepared manual intent and returns the owned projection', async () => {
    const {
      applyCompaction,
      coordinator,
      initialInstance,
      messageStore,
      prepareForManualCompaction,
      publishedEvents
    } = createHarness()
    const intent = createIntent()
    prepareForManualCompaction.mockResolvedValueOnce(intent)

    await expect(coordinator.compact(SESSION_ID)).resolves.toEqual({
      compacted: true,
      state: { status: 'compacted', cursorOrderSeq: 5, summaryUpdatedAt: 1 }
    })

    expect(applyCompaction).toHaveBeenCalledWith(intent, expect.any(AbortSignal))
    expect(messageStore.updateCompactionMessage).toHaveBeenCalledWith(
      'compaction-message',
      'compacted',
      1
    )
    expect(initialInstance?.getCompactionState()).toEqual({
      status: 'compacted',
      cursorOrderSeq: 5,
      summaryUpdatedAt: 1
    })
    expect(publishedEvents.map(({ payload }) => payload)).toEqual([
      expect.objectContaining({ status: 'compacting', cursorOrderSeq: 5 }),
      expect.objectContaining({ status: 'compacted', cursorOrderSeq: 5 })
    ])
  })

  it('does not settle idle after the operation controller loses ownership', async () => {
    const {
      canSettleOperation,
      coordinator,
      initialInstance,
      prepareForManualCompaction,
      transitionStatus
    } = createHarness()
    prepareForManualCompaction.mockImplementationOnce(async () => {
      initialInstance?.setAbortController(new AbortController())
      return null
    })
    canSettleOperation.mockReturnValueOnce(false)

    await coordinator.compact(SESSION_ID)

    expect(transitionStatus.mock.calls.map(([, status]) => status)).toEqual(['generating'])
    expect(initialInstance?.getRuntimeState()?.status).toBe('generating')
  })

  it('restores the previous projection and normalizes a late aborted failure', async () => {
    const {
      applyCompaction,
      coordinator,
      initialInstance,
      messageStore,
      publishedEvents
    } = createHarness()
    const controller = new AbortController()
    controller.abort()
    applyCompaction.mockRejectedValueOnce(new Error('late failure'))

    await expect(
      coordinator.apply(SESSION_ID, createIntent(100), { signal: controller.signal }, initialInstance)
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(messageStore.deleteMessage).toHaveBeenCalledWith('compaction-message')
    expect(initialInstance?.getCompactionState()).toEqual({
      status: 'compacted',
      cursorOrderSeq: 3,
      summaryUpdatedAt: 100
    })
    expect(publishedEvents.at(-1)?.payload).toEqual(
      expect.objectContaining({
        status: 'compacted',
        cursorOrderSeq: 3,
        summaryUpdatedAt: 100
      })
    )
  })

  it('restores the previous projection without masking a non-abort failure', async () => {
    const { applyCompaction, coordinator, initialInstance, messageStore } = createHarness()
    const failure = new Error('compaction failed')
    applyCompaction.mockRejectedValueOnce(failure)

    await expect(
      coordinator.apply(SESSION_ID, createIntent(100), undefined, initialInstance)
    ).rejects.toBe(failure)

    expect(messageStore.deleteMessage).toHaveBeenCalledWith('compaction-message')
    expect(initialInstance?.getCompactionState()).toEqual({
      status: 'compacted',
      cursorOrderSeq: 3,
      summaryUpdatedAt: 100
    })
  })
})
