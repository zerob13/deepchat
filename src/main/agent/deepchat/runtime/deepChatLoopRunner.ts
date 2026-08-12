import type { ProviderModelResolutionPort } from '@/provider/settings'
import logger from '@shared/logger'
import type { AssistantMessageBlock, MessageMetadata } from '@shared/types/agent-interface'
import type {
  ChatMessage,
  ChatMessageProviderReplayProjector
} from '@shared/types/core/chat-message'
import type { LLMCoreStreamEvent } from '@shared/types/core/llm-events'
import type { MCPToolDefinition } from '@shared/types/core/mcp'
import type { DeepChatPromptAssembly } from '@shared/types/prompt-assembly'
import type { DeepChatExecutionContract } from '@shared/types/execution-contract'
import type { DeepChatTaskContractContext } from '@shared/types/task-contract'
import type {
  ProviderExecutionPort,
  ModelConfig,
  RateLimitQueueSnapshot
} from '@shared/types/provider'
import type {
  DeepChatTapeViewPolicy,
  DeepChatTapeViewSyntheticContribution,
  DeepChatTapeViewTaskType,
  DeepChatTapeViewTokenBudget
} from '@shared/types/tape-view-manifest'
import { randomUUID } from 'node:crypto'
import { getReasoningEffectiveEnabledForProvider } from '@shared/types/model-db'
import { isTtsModelConfig, isTtsModelId } from '@shared/ttsSettings'
import { nanoid } from 'nanoid'
import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import type { DeepChatAgentInstance } from '@/agent/deepchat/instance/deepChatAgentInstance'
import type { ResolvedCommandShell } from '@shared/commandShell'
import type { MemoryIngestionObserver } from '@/agent/deepchat/memory/memoryIngestionObserver'
import type { SessionPendingInputs } from '@/session/data/pendingInputs'
import {
  appendCliProgrammaticToolAdapterSection,
  resolveEffectiveActiveSkillNames
} from '@/agent/deepchat/resources/systemPromptBuilder'
import {
  createOpaquePromptAssembly,
  reconcilePromptAssembly
} from '@/agent/deepchat/resources/promptAssembly'
import type { SessionPermissionPort } from '@/session/contracts'
import { awaitWithAbort } from '@/lib/awaitWithAbort'
import {
  buildRequestContextBudgetDiagnostics,
  buildRequestContextOverflowErrorMessage,
  capAgentRequestMaxTokens,
  AGENT_CONTEXT_SAFETY_MARGIN_TOKENS,
  estimateToolReserveTokens,
  fitRequestMessagesToContextWindow,
  preflightRequestContext
} from '@/agent/deepchat/runtime/contextBudget'
import type { ContextBuildMetadata } from '@/agent/deepchat/runtime/contextBuilder'
import type { CompactionService } from '@/agent/deepchat/runtime/compactionService'
import { resolveInterleavedReasoningConfig } from '@/agent/deepchat/runtime/generationSettings'
import { isContextWindowErrorLike } from '@/agent/deepchat/runtime/contextWindowError'
import { buildPersistableMessageTracePayload } from '@/agent/deepchat/runtime/messageTracePayload'
import { cloneBlocksForRenderer } from '@/session/clientMessageProjection'
import type { SessionTranscript } from '@/session/data/transcript'
import { processStream } from '@/agent/deepchat/runtime/process'
import type { ProviderPermissionCoordinator } from '@/agent/deepchat/runtime/providerPermissionCoordinator'
import type { SessionSummaryState, SessionSettingsStore } from '@/session/data/settings'
import { AUTO_APPROVE_REVIEW_MAX_RECENT_MESSAGES } from '@/agent/deepchat/runtime/toolPermissionReviewer'
import {
  buildExcludedRefs,
  buildIncludedRefs,
  buildRequestRefs,
  buildSyntheticContributionRefs,
  createTapeViewManifest,
  resolveTapeViewManifestPolicy,
  type TapeViewContextSelection
} from '@/tape/domain/viewManifest'
import { isCanonicalAgentExecToolSurfaceEntry } from '@/tape/domain/toolSurfaceFacts'
import type { DeepChatLoopTapePort } from '@/tape/ports/capabilities'
import { buildExecutionContract } from '@/tape/domain/executionContract'
import {
  ExecutionJournalCorruptionError,
  ExecutionJournalError,
  isExecutionJournalError
} from '@/tape/domain/executionJournal'
import type { AgentTraceSettingsPort } from '@/agent/traceSettings'
import type { RuntimeHookSink } from './runtimeHookSink'
import {
  resolveDeepChatToolProfileKind,
  type DeepChatToolResolver,
  type RunSkillToolRequirements
} from '@/agent/deepchat/runtime/toolResolver'
import type {
  ToolSurfaceProviderAttemptDiagnostic,
  ToolSurfaceShadowDiagnosticsRegistryPort
} from '@/agent/deepchat/runtime/toolSurfaceDiagnostics'
import {
  bindToolSurfaceCanaryRunEvidence,
  createToolSurfaceCanaryRunEvidenceRecorder,
  MAX_TOOL_SURFACE_PROVIDER_ATTEMPTS_PER_RUN,
  type ToolSurfaceCanaryDiagnosticsRegistry
} from './toolSurfaceCanaryDiagnostics'
import {
  collectRecentToolSurfaceNames,
  createAutomaticToolSurfaceSelectionPolicy,
  createExplicitNativeActivationPolicy,
  isAutomaticToolSurfaceRunModeAssignment,
  prepareToolSurfacePolicySelectionInputs,
  selectAutomaticToolSurfaceRunMode,
  ToolSurfaceAdapterHistory,
  type ToolSurfaceRunModeAssignment
} from '@/agent/deepchat/runtime/toolSurfaceSelection'
import type {
  DeepChatEventPublisher,
  DeepChatSessionUpdatePublisher,
  InterleavedReasoningConfig,
  ProcessResult,
  ProcessTerminalSelection,
  StreamState
} from '@/agent/deepchat/runtime/types'
import { createState } from '@/agent/deepchat/runtime/types'
import type {
  ProviderRequestTraceContext,
  ProviderRequestTracePayload
} from '@/provider/requestTrace'
import type { InputPreparationCoordinator } from '@/agent/deepchat/loop/inputPreparationCoordinator'
import type {
  DeepChatContextCoordinator,
  ProviderAttemptManifestFailureContext
} from '@/agent/deepchat/loop/contextCoordinator'
import {
  createLoopRun,
  type LoopRunToolSurfaceMode
} from '@/agent/deepchat/loop/loopRun'
import type { ToolExecutionPort, ToolResultPort } from '@/agent/deepchat/loop/ports'
import {
  buildContextCheckpoint,
  createEmptyContextRuntimeContributions,
  getContextSyntheticContributions,
  type ContextRuntimeContributions
} from './contextContributions'
import {
  resolveDeepChatContextBudgetLength,
  shouldBypassDeepChatContextBudget,
  shouldObserveToolSurfaceShadow,
  shouldUseNativeToolSurface
} from './contextBudgetPolicy'
import { resolveProviderInputCapabilities } from './providerInputCapabilities'
import {
  assertProviderModelRuntimeFacts,
  resolveProviderModelRuntimeFacts,
  type ProviderModelRuntimeFacts
} from './providerModelRuntimeFacts'
import { throwIfAbortRequested } from './abortErrors'
import type { RunLifecycleCoordinator } from './runLifecycleCoordinator'
import type { SessionScopeRegistry } from '@/agent/deepchat/instance/deepChatAgentRuntime'
import type { CompactionRuntimeCoordinator } from './compactionRuntimeCoordinator'
import {
  buildCanonicalToolCatalog,
  computeToolSurfaceVirtualizationTrigger,
  createFullToolSurfaceRunController,
  createPolicySelectedToolSurfaceRun,
  FULL_TOOL_SURFACE_POLICY_VERSION,
  projectToolSurfaceTapeProvenance,
  ToolSurfaceError,
  type ToolSurfaceRunController,
  type ToolSurfaceSnapshot
} from './toolSurface'
import { buildToolSearchDefinition } from '@/tool/agentTools/toolSearchTool'
import {
  MAX_PROGRAMMATIC_TOOL_BATCH_STEPS,
  MAX_PROGRAMMATIC_TOOL_CHILDREN,
  MAX_PROGRAMMATIC_TOOL_DURATION_MS,
  MAX_PROGRAMMATIC_TOOL_INPUT_BYTES,
  MAX_PROGRAMMATIC_TOOL_OUTPUT_BYTES,
  PROGRAMMATIC_TOOL_SURFACE_POLICY_VERSION,
  assertProgrammaticToolCapabilityViewPrepared,
  buildProgrammaticToolCapabilityV1,
  createProgrammaticToolSurfaceRunControllerV1,
  projectProgrammaticToolTapeProvenanceV1,
  type ProgrammaticToolCapabilityV1
} from './programmaticToolSurface'
import {
  meetTaskContractToolDefinitions,
  resolveExecutionContractSubagentDepth
} from './taskContractCapability'
import type { PromptAssemblyService } from './promptAssemblyService'
import type { SessionIdentityService } from './sessionIdentityService'
import type { SessionSettingsCoordinator } from './sessionSettingsCoordinator'
import type { ToolPermissionReviewer } from './toolRuntimeBindings'
import type { ProgrammaticToolParentRegistry } from '@/cli/programmaticToolParentRegistry'
import { CommittedRunProjectionError } from './runTerminalProjectionError'

function wrapTerminalCommitFailure(
  executionError: unknown,
  terminalCommitError: unknown
): ExecutionJournalError {
  const terminalFailureCause = isExecutionJournalError(terminalCommitError)
    ? terminalCommitError.cause
    : terminalCommitError
  const combinedCause =
    terminalFailureCause === undefined || terminalFailureCause === executionError
      ? executionError
      : new AggregateError(
          [executionError, terminalFailureCause],
          'Run execution and terminal commit both failed.'
        )

  if (terminalCommitError instanceof ExecutionJournalCorruptionError) {
    return new ExecutionJournalCorruptionError(terminalCommitError.message, {
      cause: combinedCause
    })
  }
  if (isExecutionJournalError(terminalCommitError)) {
    return new ExecutionJournalError(terminalCommitError.message, terminalCommitError.code, {
      cause: combinedCause
    })
  }
  return new ExecutionJournalError(
    terminalCommitError instanceof Error
      ? terminalCommitError.message
      : String(terminalCommitError),
    'persistence_failed',
    { cause: combinedCause }
  )
}

type LoopRunLifecyclePort = Pick<
  RunLifecycleCoordinator,
  | 'assertCurrentInstance'
  | 'clearRun'
  | 'ensureOperationController'
  | 'markFirstTurnReady'
  | 'registerRun'
  | 'scopeFor'
>

export interface ToolSurfaceRunModePort {
  /**
   * Internal rollout assignment. An automatic assignment must carry measured provider/model CLI
   * capability instead of inferring it from native function calling. Fixed non-legacy modes remain
   * available for bounded canary cohorts and tests. Absence keeps production on legacy behavior.
   */
  resolve(input: {
    readonly sessionId: string
    readonly providerId: string
    readonly modelId: string
  }): ToolSurfaceRunModeAssignment
}

const PROVIDER_OVERFLOW_RETRY_EXTRA_RESERVE_CAP = 8_192
const RATE_LIMIT_STREAM_MESSAGE_PREFIX = '__rate_limit__:'
const MAX_PROVIDER_VIEW_PROVENANCE_DIAGNOSTICS_PER_RUN = 8
const MAX_PROVIDER_VIEW_PROVENANCE_FAILURE_REASON_CODE_UNITS = 512

function boundedProviderViewProvenanceFailureReason(error: unknown): string {
  let reason = 'Unknown persistence failure.'
  try {
    const candidate = error instanceof Error ? error.message : error
    if (typeof candidate === 'string' && candidate.length > 0) {
      reason = candidate
    }
  } catch {}
  const truncated = reason.length > MAX_PROVIDER_VIEW_PROVENANCE_FAILURE_REASON_CODE_UNITS
  const retainedLimit =
    MAX_PROVIDER_VIEW_PROVENANCE_FAILURE_REASON_CODE_UNITS - (truncated ? 3 : 0)
  let retained = ''
  for (let index = 0; index < reason.length && retained.length < retainedLimit; ) {
    const codePoint = reason.codePointAt(index)
    if (codePoint === undefined) break
    const character = String.fromCodePoint(codePoint)
    index += character.length
    const controlCharacter =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    const retainedCharacter = controlCharacter ? ' ' : character
    if (retained.length + retainedCharacter.length > retainedLimit) break
    retained += retainedCharacter
  }
  const normalized = retained.trim()
  if (!normalized) return 'Unknown persistence failure.'
  return truncated ? `${normalized}...` : normalized
}

function createProviderViewProvenanceDiagnosticReporter(): (
  error: unknown,
  context: ProviderAttemptManifestFailureContext
) => void {
  let emitted = 0
  let suppressionReported = false
  return (error, context): void => {
    if (emitted < MAX_PROVIDER_VIEW_PROVENANCE_DIAGNOSTICS_PER_RUN) {
      emitted += 1
      logger.warn('[DeepChatAgent] Provider View provenance persistence failed', {
        schemaVersion: 1,
        requestSeq: context.requestSeq,
        failurePolicy: context.failurePolicy,
        toolSurfaceApplicable: context.toolSurfaceApplicable,
        verified: context.verified,
        reason: boundedProviderViewProvenanceFailureReason(error)
      })
      return
    }
    if (suppressionReported) return
    suppressionReported = true
    logger.warn('[DeepChatAgent] Additional provider View provenance diagnostics suppressed', {
      schemaVersion: 1,
      limit: MAX_PROVIDER_VIEW_PROVENANCE_DIAGNOSTICS_PER_RUN
    })
  }
}

export type PendingTapeViewContext = {
  taskType: DeepChatTapeViewTaskType
  policy: DeepChatTapeViewPolicy
  policyVersion?: number | null
  selection: TapeViewContextSelection
  summaryCursorOrderSeq: number
  supportsVision: boolean
  supportsAudioInput: boolean
  traceDebugEnabled: boolean
  contextBuilderVersion: 'legacy-v1' | 'cache-aware-v1'
  syntheticContributions?: DeepChatTapeViewSyntheticContribution[]
}

export type DeepChatLoopRunInput = {
  sessionId: string
  messageId: string
  messages: ChatMessage[]
  projectDir: string | null
  resourceInstance?: DeepChatAgentInstance
  providerModelFacts?: ProviderModelRuntimeFacts
  taskContractContext: DeepChatTaskContractContext | null
  tools?: MCPToolDefinition[]
  commandShell: ResolvedCommandShell
  baseSystemPrompt?: string
  basePromptAssembly?: DeepChatPromptAssembly
  contextContributions?: ContextRuntimeContributions
  initialBlocks?: AssistantMessageBlock[]
  initialAccounting?: MessageMetadata
  providerReplayProjector?: ChatMessageProviderReplayProjector
  promptPreview?: string
  search?: boolean
  interleavedReasoning?: InterleavedReasoningConfig
  viewContext?: PendingTapeViewContext
  refreshSystemPrompt?: (
    activeSkillNames: string[] | undefined,
    toolDefinitions: MCPToolDefinition[]
  ) => Promise<DeepChatPromptAssembly | string>
  maxProviderRounds?: number
  onBeforeProviderStream?: () => void
  onRunRegistered?: (runId: string) => void
  abortController?: AbortController
}

export interface CommitTapeProviderViewInput {
  sessionId: string
  messageId: string
  requestSeq: number
  taskType: DeepChatTapeViewTaskType
  policy: DeepChatTapeViewPolicy
  policyVersion?: number | null
  messages: ChatMessage[]
  tools: MCPToolDefinition[]
  tokenBudget: Omit<DeepChatTapeViewTokenBudget, 'estimatedPromptTokens'>
  providerId: string
  modelId: string
  selection?: TapeViewContextSelection
  summaryCursorOrderSeq: number
  supportsVision: boolean
  supportsAudioInput: boolean
  traceDebugEnabled: boolean
  contextBuilderVersion: 'legacy-v1' | 'cache-aware-v1'
  syntheticContributions?: DeepChatTapeViewSyntheticContribution[]
  executionContract?: DeepChatExecutionContract
  toolSurfaceSnapshot?: ToolSurfaceSnapshot | null
  programmaticToolCapability: ProgrammaticToolCapabilityV1 | null
}

export interface DeepChatLoopRunnerPorts {
  publishEvent: DeepChatEventPublisher
  publishSessionUpdate: DeepChatSessionUpdatePublisher
  providerRuntime: ProviderExecutionPort
  providerSettings: ProviderModelResolutionPort
  traceSettings: AgentTraceSettingsPort
  sessionStore: SessionSettingsStore
  messageStore: SessionTranscript
  tape: DeepChatLoopTapePort
  pendingInputCoordinator: SessionPendingInputs
  toolResolver: DeepChatToolResolver
  providerPermissionCoordinator: ProviderPermissionCoordinator
  compactionService: CompactionService
  inputPreparationCoordinator: InputPreparationCoordinator
  contextCoordinator: DeepChatContextCoordinator
  toolSurfaceRunMode?: ToolSurfaceRunModePort
  programmaticToolParents: Pick<
    ProgrammaticToolParentRegistry,
    'prepare' | 'commitRunTerminal'
  >
  toolSurfaceDiagnostics: ToolSurfaceShadowDiagnosticsRegistryPort
  toolSurfaceCanaryDiagnostics: Pick<
    ToolSurfaceCanaryDiagnosticsRegistry,
    'recordAutomaticAssignment' | 'recordRun'
  >
  memoryIngestionObserver: MemoryIngestionObserver
  toolExecutionPort: ToolExecutionPort
  toolResultPort: ToolResultPort
  cacheImage(data: string): Promise<string>
  registry: SessionScopeRegistry
  sessionSettings: Pick<SessionSettingsCoordinator, 'getEffectiveGenerationSettings'>
  promptAssembly: Pick<PromptAssemblyService, 'createBasePromptAssembler'>
  runLifecycle: LoopRunLifecyclePort
  identity: Pick<
    SessionIdentityService,
    'getAgentId' | 'getSessionKind' | 'isAcpBackedSubagentSession'
  >
  sessionPermissionPort: SessionPermissionPort
  reviewToolPermission: ToolPermissionReviewer
  hookSink: Pick<RuntimeHookSink, 'scope'>
  compaction: Pick<CompactionRuntimeCoordinator, 'apply'>
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Aborted', 'AbortError')
  }

  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function getProviderOverflowRetryExtraReserve(contextLength: number): number {
  if (!Number.isFinite(contextLength) || contextLength <= 0) {
    return 0
  }
  return Math.max(
    AGENT_CONTEXT_SAFETY_MARGIN_TOKENS,
    Math.min(Math.floor(contextLength * 0.1), PROVIDER_OVERFLOW_RETRY_EXTRA_RESERVE_CAP)
  )
}

function getProviderOverflowRetryMaxTokens(maxTokens: number): number {
  const normalized = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : 1
  return Math.max(1, Math.min(normalized, Math.floor(normalized / 2) || 1))
}

function projectSystemPrompt(
  messages: readonly ChatMessage[],
  systemPrompt: string
): ChatMessage[] {
  if (messages[0]?.role === 'system') {
    return [{ ...messages[0], content: systemPrompt }, ...messages.slice(1)]
  }
  return [{ role: 'system', content: systemPrompt }, ...messages]
}

function isFirstProviderContextOverflowEvent(event: LLMCoreStreamEvent): boolean {
  return event.type === 'error' && isContextWindowErrorLike(event.error_message)
}

function buildProviderContextOverflowAfterRecoveryErrorMessage(
  preflight: ReturnType<typeof preflightRequestContext>
): string {
  const diagnostics = buildRequestContextBudgetDiagnostics(preflight)
  const formatTokenCount = (value: number): string =>
    Number.isFinite(value) ? String(Math.floor(value)) : 'unknown'

  return [
    'The provider still reported a context overflow after DeepChat compacted or trimmed the request.',
    `DeepChat local estimate: usable context ${formatTokenCount(diagnostics.usableContextLength)} tokens, estimated input ${formatTokenCount(diagnostics.inputTokens)} tokens, tool schemas ${formatTokenCount(diagnostics.toolReserveTokens)} tokens, requested output ${formatTokenCount(diagnostics.requestedMaxTokens)} tokens, effective output ${formatTokenCount(diagnostics.effectiveMaxTokens)} tokens, remaining output room ${formatTokenCount(diagnostics.remainingOutputTokens)} tokens.`,
    'The provider may count tokens, system prompts, or tool schemas differently. Try shortening the latest input or attachments, reducing active tools, skills, or system prompt content, lowering max output tokens, or increasing context length.'
  ].join(' ')
}

function selectProcessTerminal(result: ProcessResult): ProcessTerminalSelection {
  let stopReason = result.stopReason
  if (!stopReason) {
    switch (result.status) {
      case 'paused':
        stopReason = 'interaction'
        break
      case 'aborted':
        stopReason = 'user_stop'
        break
      case 'error':
        stopReason = result.terminalError ? 'tool_error' : 'provider_error'
        break
      case 'completed':
        stopReason = 'complete'
        break
    }
  }

  const errorMessage =
    result.status === 'error'
      ? (result.terminalError ?? result.errorMessage ?? 'Unknown error')
      : result.status === 'aborted'
        ? result.errorMessage
        : undefined
  return {
    outcome: result.status,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage })
  }
}

export function buildTapeViewSelection(
  metadata: ContextBuildMetadata,
  newUserMessageId?: string | null
): TapeViewContextSelection {
  return {
    includedRecords: metadata.includedRecords,
    excludedRecords: metadata.excludedRecords,
    summaryCursor: metadata.summaryCursor,
    includesSystemPrompt: metadata.includesSystemPrompt,
    syntheticContributions: metadata.syntheticContributions,
    newUserMessageId
  }
}

export class DeepChatLoopRunner {
  private readonly toolSurfaceAdapterHistory = new ToolSurfaceAdapterHistory()

  constructor(private readonly ports: DeepChatLoopRunnerPorts) {}

  async run(args: DeepChatLoopRunInput): Promise<{ runId: string; result: ProcessResult }> {
    const toolSurfaceCanaryStartedAt = Date.now()
    const {
      sessionId,
      messageId,
      messages,
      projectDir,
      resourceInstance: providedResourceInstance,
      providerModelFacts: providedProviderModelFacts,
      taskContractContext,
      tools: providedTools,
      commandShell,
      baseSystemPrompt,
      basePromptAssembly,
      contextContributions,
      initialBlocks,
      initialAccounting,
      providerReplayProjector,
      promptPreview,
      search,
      interleavedReasoning: providedInterleavedReasoning,
      viewContext,
      refreshSystemPrompt,
      maxProviderRounds,
      onBeforeProviderStream,
      onRunRegistered,
      abortController: providedAbortController
    } = args
    let activeContextContributions = contextContributions
    const getOrCreateContextContributions = (): ContextRuntimeContributions => {
      activeContextContributions ??= createEmptyContextRuntimeContributions()
      return activeContextContributions
    }
    const resourceInstance = providedResourceInstance ?? this.ports.registry.getOrHydrateScope(toAppSessionId(sessionId)).instance
    const resourceScope = this.ports.runLifecycle.scopeFor(sessionId, resourceInstance)
    resourceScope.assertCurrent()
    const abortController =
      providedAbortController ?? this.ports.runLifecycle.ensureOperationController(resourceScope)
    const abortSignal = abortController.signal
    throwIfAbortRequested(abortSignal)
    const state = resourceInstance.getRuntimeState()
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }
    if (messages.length === 0) {
      throw new Error('Request was not sent because the prompt is empty.')
    }
    const sessionKind = this.ports.identity.getSessionKind(sessionId)
    const acpBackedSubagent = this.ports.identity.isAcpBackedSubagentSession(
      sessionId,
      state.providerId
    )
    const strictViewContract = sessionKind === 'subagent' && !acpBackedSubagent
    if (strictViewContract && !taskContractContext) {
      throw new Error('Contract-bearing child run requires a TaskContract context.')
    }
    const reportProviderViewProvenanceFailure =
      createProviderViewProvenanceDiagnosticReporter()

    const providerModelFacts =
      providedProviderModelFacts ??
      resolveProviderModelRuntimeFacts(
        this.ports.providerSettings,
        state.providerId,
        state.modelId
      )
    assertProviderModelRuntimeFacts(providerModelFacts, state.providerId, state.modelId)
    const generationSettings = await awaitWithAbort(
      this.ports.sessionSettings.getEffectiveGenerationSettings(
        sessionId,
        resourceInstance,
        providerModelFacts
      ),
      abortSignal
    )
    const baseModelConfig = providerModelFacts.modelConfig
    const observeToolSurfaceShadow =
      !acpBackedSubagent &&
      shouldObserveToolSurfaceShadow(state.providerId, baseModelConfig, state.modelId)
    const nativeToolSurfaceEligible =
      !acpBackedSubagent &&
      shouldUseNativeToolSurface(state.providerId, baseModelConfig, state.modelId)
    const capabilitySnapshot = providerModelFacts.capabilitySnapshot
    const interleavedReasoning =
      providedInterleavedReasoning ??
      resolveInterleavedReasoningConfig(
        this.ports.providerSettings,
        state.providerId,
        state.modelId,
        generationSettings,
        capabilitySnapshot
      )
    const contextBudgetLength = resolveDeepChatContextBudgetLength(
      state.providerId,
      generationSettings.contextLength,
      baseModelConfig,
      state.modelId
    )
    const capabilityProviderId = capabilitySnapshot.identity.providerId
    const reasoningPortrait = capabilitySnapshot.reasoningPortrait
    const modelConfig: ModelConfig = {
      ...baseModelConfig,
      temperature: generationSettings.temperature,
      topP: generationSettings.topP,
      contextLength: generationSettings.contextLength,
      maxTokens: capAgentRequestMaxTokens(generationSettings.maxTokens, contextBudgetLength),
      timeout: generationSettings.timeout,
      thinkingBudget: generationSettings.thinkingBudget,
      reasoningEffort: generationSettings.reasoningEffort,
      reasoningVisibility: generationSettings.reasoningVisibility,
      verbosity: generationSettings.verbosity,
      imageGeneration: generationSettings.imageGeneration,
      videoGeneration: generationSettings.videoGeneration,
      reasoning: getReasoningEffectiveEnabledForProvider(capabilityProviderId, reasoningPortrait, {
        reasoning: baseModelConfig.reasoning,
        reasoningEffort: generationSettings.reasoningEffort ?? baseModelConfig.reasoningEffort
      }),
      conversationId: sessionId
    }

    const traceEnabled = this.ports.traceSettings.isEnabled()
    const initialRequestSeq = Math.max(
      this.ports.tape.listViewManifestsByMessage(sessionId, messageId)[0]
        ?.requestSeq ?? 0,
      this.ports.messageStore.getMaxMessageTraceRequestSeq(messageId),
      this.ports.tape.getMaxProviderAttemptRequestSeq(sessionId, messageId)
    )
    const temperature = generationSettings.temperature
    const maxTokens = capAgentRequestMaxTokens(generationSettings.maxTokens, contextBudgetLength)
    const effectiveSystemPrompt =
      messages[0]?.role === 'system' && typeof messages[0].content === 'string'
        ? messages[0].content
        : ''
    const declaredPromptAssembly =
      basePromptAssembly ??
      createOpaquePromptAssembly(baseSystemPrompt ?? effectiveSystemPrompt)
    const initialPromptAssembly = reconcilePromptAssembly(
      declaredPromptAssembly,
      effectiveSystemPrompt
    )

    const streamSessionActiveSkillNames = await awaitWithAbort(
      this.ports.toolResolver.resolveActiveSkillNamesForToolProfile(sessionId),
      abortSignal
    )
    resourceScope.assertCurrent()
    const streamExtensionPolicy = await awaitWithAbort(
      this.ports.toolResolver.resolveAgentExtensionPolicy(sessionId, resourceInstance),
      abortSignal
    )
    resourceScope.assertCurrent()
    const getEffectiveRuntimeSkillNames = (baseSkillNames = streamSessionActiveSkillNames) =>
      resolveEffectiveActiveSkillNames(baseSkillNames, resourceInstance)
    const unconstrainedToolCatalog = this.ports.toolResolver.createSessionToolCatalogPort(
      sessionId,
      projectDir,
      resourceInstance
    )
    const toolCatalog = {
      resolve: async (request?: { activeSkillNames?: string[] }) => {
        const resolved = await unconstrainedToolCatalog.resolve(request)
        return meetTaskContractToolDefinitions(sessionId, resolved, taskContractContext)
      }
    }
    const tools =
      providedTools ??
      (await awaitWithAbort(
        toolCatalog.resolve({ activeSkillNames: getEffectiveRuntimeSkillNames() }),
        abortSignal
      ))
    resourceScope.assertCurrent()
    const initialRunSkillNames = getEffectiveRuntimeSkillNames()
    const initialToolProfileRevisionToken = resourceInstance.getToolProfileRevisionToken()
    const toolProfile = resolveDeepChatToolProfileKind(projectDir)
    const toolSurfaceAssignment =
      this.ports.toolSurfaceRunMode?.resolve({
        sessionId,
        providerId: state.providerId,
        modelId: state.modelId
      }) ?? 'legacy'
    const automaticToolSurfaceAssignment = isAutomaticToolSurfaceRunModeAssignment(
      toolSurfaceAssignment
    )
      ? toolSurfaceAssignment
      : null
    const toolSurfaceCanaryScope = Object.freeze({
      sessionId,
      providerId: state.providerId,
      modelId: state.modelId,
      toolProfile
    })
    if (automaticToolSurfaceAssignment) {
      this.ports.toolSurfaceCanaryDiagnostics.recordAutomaticAssignment({
        scope: toolSurfaceCanaryScope,
        cliProgrammaticCapability:
          automaticToolSurfaceAssignment.cliProgrammaticCapability,
        phase: 'entered'
      })
      if (!nativeToolSurfaceEligible) {
        this.ports.toolSurfaceCanaryDiagnostics.recordAutomaticAssignment({
          scope: toolSurfaceCanaryScope,
          cliProgrammaticCapability:
            automaticToolSurfaceAssignment.cliProgrammaticCapability,
          phase: 'excluded'
        })
      }
    }
    const fixedToolSurfaceMode =
      typeof toolSurfaceAssignment === 'string' ? toolSurfaceAssignment : null
    const automaticToolSurfaceHistoryScope = automaticToolSurfaceAssignment
      ? Object.freeze({
          sessionId,
          providerId: state.providerId,
          modelId: state.modelId,
          toolProfile
        })
      : null
    const previousAutomaticToolSurfaceMode = automaticToolSurfaceAssignment
      ? (automaticToolSurfaceAssignment.previousMode ??
        (automaticToolSurfaceHistoryScope
          ? this.toolSurfaceAdapterHistory.previousMode({
              instance: resourceInstance,
              scope: automaticToolSurfaceHistoryScope
            })
          : null))
      : null
    if (
      !automaticToolSurfaceAssignment &&
      fixedToolSurfaceMode !== 'legacy' &&
      fixedToolSurfaceMode !== 'full' &&
      fixedToolSurfaceMode !== 'native-activation' &&
      fixedToolSurfaceMode !== 'cli-programmatic'
    ) {
      throw new Error('Tool Surface assignment returned an unsupported Run mode.')
    }
    let toolSurfaceMode: LoopRunToolSurfaceMode = automaticToolSurfaceAssignment
      ? nativeToolSurfaceEligible
        ? 'full'
        : 'legacy'
      : (fixedToolSurfaceMode ?? 'legacy')
    if (!automaticToolSurfaceAssignment && toolSurfaceMode !== 'legacy' && !nativeToolSurfaceEligible) {
      throw new Error(
        `${
          toolSurfaceMode === 'full'
            ? 'Full Tool Surface'
            : toolSurfaceMode === 'native-activation'
              ? 'Native Activation Tool Surface'
              : 'CLI Programmatic Tool Surface'
        } mode requires a native chat model with provider-native function calling.`
      )
    }
    let toolSurfaceController: ToolSurfaceRunController | null = null
    let programmaticProviderActiveDefinitions: readonly MCPToolDefinition[] | null = null
    let frozenSkillRequirementByName: ReadonlyMap<string, RunSkillToolRequirements> | null = null
    try {
      if (toolSurfaceMode !== 'legacy') {
      const universe = await awaitWithAbort(
        this.ports.toolResolver.resolveRunToolDefinitionUniverse(
          sessionId,
          projectDir,
          initialRunSkillNames,
          resourceInstance,
          abortSignal
        ),
        abortSignal
      )
      resourceScope.assertCurrent()
      if (!universe.complete || universe.mandatoryAdmissionBlocked) {
        throw new Error(
          `${
            automaticToolSurfaceAssignment
              ? 'Automatic Tool Surface'
              : toolSurfaceMode === 'full'
              ? 'Full Tool Surface'
              : toolSurfaceMode === 'native-activation'
                ? 'Native Activation Tool Surface'
                : 'CLI Programmatic Tool Surface'
          } mode requires a complete Run tool universe.`
        )
      }
      const ceilingDefinitions = meetTaskContractToolDefinitions(
        sessionId,
        universe.definitions,
        taskContractContext
      )
      if (automaticToolSurfaceAssignment) {
        const toolSearchDefinition = buildToolSearchDefinition()
        const automaticPolicy = createAutomaticToolSurfaceSelectionPolicy(
          buildCanonicalToolCatalog([toolSearchDefinition]).definitionTokens
        )
        const ceilingCatalog = buildCanonicalToolCatalog(ceilingDefinitions)
        const trigger = computeToolSurfaceVirtualizationTrigger({
          policy: automaticPolicy,
          ceilingToolCount: ceilingCatalog.entries.length,
          ceilingDefinitionTokens: ceilingCatalog.definitionTokens,
          previouslyVirtualized:
            previousAutomaticToolSurfaceMode === 'native-activation' ||
            previousAutomaticToolSurfaceMode === 'cli-programmatic'
        })
        const initialProviderActiveDefinitions = tools.filter(
          (definition) => definition.source === 'agent'
        )
        const agentExecAvailable = buildCanonicalToolCatalog(
          initialProviderActiveDefinitions
        ).entries.some(isCanonicalAgentExecToolSurfaceEntry)
        let programmaticController: ToolSurfaceRunController | null = null
        if (
          trigger.virtualizationTriggered &&
          previousAutomaticToolSurfaceMode !== 'native-activation' &&
          automaticToolSurfaceAssignment.cliProgrammaticCapability === 'proven' &&
          agentExecAvailable
        ) {
          try {
            programmaticController = createProgrammaticToolSurfaceRunControllerV1({
              ceilingDefinitions: [
                ...initialProviderActiveDefinitions,
                ...ceilingDefinitions.filter((definition) => definition.source === 'mcp')
              ],
              providerActiveDefinitions: initialProviderActiveDefinitions,
              policyVersion: PROGRAMMATIC_TOOL_SURFACE_POLICY_VERSION
            })
          } catch (error) {
            if (
              !(error instanceof ToolSurfaceError) ||
              (error.code !== 'limit_exceeded' && error.code !== 'ineligible_exposure')
            ) {
              throw error
            }
          }
        }
        toolSurfaceMode = selectAutomaticToolSurfaceRunMode({
          virtualizationTriggered: trigger.virtualizationTriggered,
          cliProgrammaticCapability: automaticToolSurfaceAssignment.cliProgrammaticCapability,
          agentExecAvailable,
          programmaticRunCeilingFits: programmaticController !== null,
          ...(previousAutomaticToolSurfaceMode
            ? { previousMode: previousAutomaticToolSurfaceMode }
            : {})
        })
        if (toolSurfaceMode === 'cli-programmatic') {
          if (!programmaticController) {
            throw new Error('CLI Programmatic selection requires a preflighted Run controller.')
          }
          toolSurfaceController = programmaticController
          programmaticProviderActiveDefinitions = Object.freeze(
            toolSurfaceController.ceiling.entries
              .filter((entry) => entry.catalogEntry.target.source === 'agent')
              .map((entry) => entry.definition)
          )
        } else if (toolSurfaceMode === 'native-activation') {
          const eligibleCatalog = buildCanonicalToolCatalog(tools)
          const activeSkillRequiredStableTargetKeys = universe.skillRequirements
            .filter((requirement) => requirement.activeAtRunStart && requirement.activatable)
            .flatMap((requirement) => requirement.requiredStableTargetKeys)
          const selectionInputs = prepareToolSurfacePolicySelectionInputs({
            eligibleCatalog,
            toolProfile,
            activeSkillRequiredStableTargetKeys,
            recentToolNames: collectRecentToolSurfaceNames(messages)
          })
          const selected = createPolicySelectedToolSurfaceRun({
            ceilingDefinitions,
            initialEligibleDefinitions: tools,
            toolSearchDefinition,
            policy: automaticPolicy,
            previouslyVirtualized:
              previousAutomaticToolSurfaceMode === 'native-activation' ||
              previousAutomaticToolSurfaceMode === 'cli-programmatic',
            ...selectionInputs
          })
          if (!selected.decision.virtualizationTriggered) {
            throw new Error('Native Activation route lost its automatic virtualization decision.')
          }
          toolSurfaceController = selected.controller
          frozenSkillRequirementByName = new Map(
            universe.skillRequirements.map((requirement) => [requirement.skillName, requirement])
          )
          if (!toolSurfaceController.prepareSkillActivation) {
            throw new Error('Native Activation controller cannot prepare Skill activation.')
          }
        } else {
          toolSurfaceController = createFullToolSurfaceRunController({
            ceilingDefinitions,
            initialActiveDefinitions: tools,
            policyVersion: automaticPolicy.policyVersion
          })
        }
      } else if (toolSurfaceMode === 'full') {
        toolSurfaceController = createFullToolSurfaceRunController({
          ceilingDefinitions,
          initialActiveDefinitions: tools,
          policyVersion: FULL_TOOL_SURFACE_POLICY_VERSION
        })
      } else if (toolSurfaceMode === 'native-activation') {
        frozenSkillRequirementByName = new Map(
          universe.skillRequirements.map((requirement) => [requirement.skillName, requirement])
        )
        const eligibleCatalog = buildCanonicalToolCatalog(tools)
        const activeSkillRequiredStableTargetKeys = universe.skillRequirements
          .filter((requirement) => requirement.activeAtRunStart && requirement.activatable)
          .flatMap((requirement) => requirement.requiredStableTargetKeys)
        const selectionInputs = prepareToolSurfacePolicySelectionInputs({
          eligibleCatalog,
          toolProfile,
          activeSkillRequiredStableTargetKeys,
          recentToolNames: collectRecentToolSurfaceNames(messages)
        })
        const toolSearchDefinition = buildToolSearchDefinition()
        const selected = createPolicySelectedToolSurfaceRun({
          ceilingDefinitions,
          initialEligibleDefinitions: tools,
          toolSearchDefinition,
          policy: createExplicitNativeActivationPolicy(
            buildCanonicalToolCatalog([toolSearchDefinition]).definitionTokens
          ),
          previouslyVirtualized: true,
          ...selectionInputs
        })
        if (!selected.decision.virtualizationTriggered) {
          throw new Error('Native Activation assignment did not produce a virtualized controller.')
        }
        toolSurfaceController = selected.controller
        if (!toolSurfaceController.prepareSkillActivation) {
          throw new Error('Native Activation controller cannot prepare Skill activation.')
        }
      } else {
        const initialProviderActiveDefinitions = tools.filter(
          (definition) => definition.source === 'agent'
        )
        toolSurfaceController = createProgrammaticToolSurfaceRunControllerV1({
          ceilingDefinitions: [
            ...initialProviderActiveDefinitions,
            ...ceilingDefinitions.filter((definition) => definition.source === 'mcp')
          ],
          providerActiveDefinitions: initialProviderActiveDefinitions,
          policyVersion: PROGRAMMATIC_TOOL_SURFACE_POLICY_VERSION
        })
        programmaticProviderActiveDefinitions = Object.freeze(
          toolSurfaceController.ceiling.entries
            .filter((entry) => entry.catalogEntry.target.source === 'agent')
            .map((entry) => entry.definition)
        )
      }
      }
    } catch (error) {
      if (automaticToolSurfaceAssignment) {
        this.ports.toolSurfaceCanaryDiagnostics.recordAutomaticAssignment({
          scope: toolSurfaceCanaryScope,
          cliProgrammaticCapability:
            automaticToolSurfaceAssignment.cliProgrammaticCapability,
          phase: abortSignal.aborted ? 'aborted' : 'setup-failed'
        })
      }
      throw error
    }
    if (automaticToolSurfaceAssignment && toolSurfaceMode !== 'legacy') {
      this.ports.toolSurfaceCanaryDiagnostics.recordAutomaticAssignment({
        scope: toolSurfaceCanaryScope,
        cliProgrammaticCapability:
          automaticToolSurfaceAssignment.cliProgrammaticCapability,
        phase: 'selected',
        adapterMode: toolSurfaceMode
      })
    }
    const collectToolSurfaceShadow = observeToolSurfaceShadow && toolSurfaceMode === 'legacy'
    const toolSurfaceCanaryIdentity = toolSurfaceController
      ? Object.freeze({
          policyVersion: toolSurfaceController.policyVersion,
          catalogHash: toolSurfaceController.ceiling.catalog.fullCatalogHash,
          catalogToolCount: toolSurfaceController.ceiling.catalog.entries.length,
          catalogDefinitionTokens: toolSurfaceController.ceiling.catalog.definitionTokens
        })
      : null
    const toolSurfaceCanaryEvidence = toolSurfaceCanaryIdentity
      ? createToolSurfaceCanaryRunEvidenceRecorder()
      : null
    const runPromptAssembly =
      toolSurfaceMode === 'cli-programmatic'
        ? appendCliProgrammaticToolAdapterSection(initialPromptAssembly)
        : initialPromptAssembly
    const runMessages =
      runPromptAssembly === initialPromptAssembly
        ? messages
        : projectSystemPrompt(messages, runPromptAssembly.prompt)
    const resolveRefreshedPromptAssembly = async (
      activeSkillNames: string[] | undefined,
      refreshedTools: MCPToolDefinition[]
    ): Promise<DeepChatPromptAssembly> => {
      if (refreshSystemPrompt) {
        const refreshed = await refreshSystemPrompt(
          getEffectiveRuntimeSkillNames(activeSkillNames),
          refreshedTools
        )
        const refreshedAssembly =
          typeof refreshed === 'string' ? createOpaquePromptAssembly(refreshed) : refreshed
        return toolSurfaceMode === 'cli-programmatic'
          ? appendCliProgrammaticToolAdapterSection(refreshedAssembly)
          : refreshedAssembly
      }
      const refreshedAssembly = await this.ports.promptAssembly
        .createBasePromptAssembler(resourceInstance)
        .assembleWithProvenance({
          sessionId: toAppSessionId(sessionId),
          configuredPrompt: generationSettings.systemPrompt,
          toolDefinitions: refreshedTools,
          activeSkillNames: getEffectiveRuntimeSkillNames(activeSkillNames),
          commandShell
        })
      return toolSurfaceMode === 'cli-programmatic'
        ? appendCliProgrammaticToolAdapterSection(refreshedAssembly)
        : refreshedAssembly
    }
    const { supportsVision, supportsAudioInput } = resolveProviderInputCapabilities(
      this.ports.providerSettings,
      state.providerId,
      state.modelId,
      providerModelFacts
    )

    abortController.signal.throwIfAborted()
    resourceScope.assertCurrent()
    const loopRun = createLoopRun<StreamState>({
      runId: randomUUID(),
      sessionId: toAppSessionId(sessionId),
      messageId,
      abortController,
      messages: runMessages,
      streamState: createState(),
      resources: {
        toolDefinitions: tools,
        activeSkillNames: initialRunSkillNames,
        promptAssembly: runPromptAssembly,
        commandShell,
        toolSurfaceMode
      },
      initialRequestSeq
    })
    const runStarted = this.ports.tape.commitRunStarted({
      sessionId,
      runId: loopRun.runId,
      messageId,
      runKind: 'loop',
      createdAt: loopRun.startedAt
    })
    if (!runStarted.created) {
      throw new ExecutionJournalCorruptionError(
        `Execution Journal run identity ${loopRun.runId} was already committed.`
      )
    }

    const toolSurfaceProviderAttempts: ToolSurfaceProviderAttemptDiagnostic[] = []
    let toolSurfaceProviderAttemptsTruncated = false
    let toolSurfaceFirstProviderEventAt: number | null = null

    let terminalCommitAttempted = false
    let committedTerminal: ProcessTerminalSelection | null = null
    const readCommittedTerminal = (): ProcessTerminalSelection | null => committedTerminal
    const commitRunTerminal = (selection: ProcessTerminalSelection): void => {
      if (committedTerminal) {
        if (
          committedTerminal.outcome === selection.outcome &&
          committedTerminal.stopReason === selection.stopReason &&
          committedTerminal.errorMessage === selection.errorMessage
        ) {
          return
        }
        throw new ExecutionJournalCorruptionError(
          `Run ${loopRun.runId} selected conflicting terminal outcomes.`
        )
      }
      resourceScope.assertCurrent()
      if (terminalCommitAttempted) {
        throw new ExecutionJournalCorruptionError(
          `Run ${loopRun.runId} repeated a failed terminal commit.`
        )
      }

      terminalCommitAttempted = true
      const receipt = this.ports.programmaticToolParents.commitRunTerminal(
        { sessionId, runId: loopRun.runId },
        () =>
          this.ports.tape.commitRunTerminal({
            sessionId,
            runId: loopRun.runId,
            messageId,
            outcome: selection.outcome,
            stopReason: selection.stopReason,
            ...(selection.errorMessage === undefined
              ? {}
              : { errorMessage: selection.errorMessage })
          })
      )
      if (!receipt.created) {
        throw new ExecutionJournalCorruptionError(
          `Execution Journal terminal for Run ${loopRun.runId} already existed.`
        )
      }
      committedTerminal = { ...selection }
    }

    try {
      const activeGeneration = this.ports.runLifecycle.registerRun(resourceScope, loopRun)
      onRunRegistered?.(activeGeneration.runId)
      const rateLimitMessageId = `${RATE_LIMIT_STREAM_MESSAGE_PREFIX}${activeGeneration.runId}`
      let crossedPreStreamBoundary = false
      const crossPreStreamBoundary = () => {
        if (crossedPreStreamBoundary) return
        crossedPreStreamBoundary = true
        onBeforeProviderStream?.()
      }
      const ports = this.ports
      const recoverRequestContextPressure = this.recoverRequestContextPressure.bind(this)
      const commitTapeProviderView = this.commitTapeProviderView.bind(this)
      const persistMessageTrace = this.persistMessageTrace.bind(this)
      const emitRateLimitWaitingMessage = this.emitRateLimitWaitingMessage.bind(this)
      const clearRateLimitWaitingMessage = this.clearRateLimitWaitingMessage.bind(this)
      const toolSurfaceAdapterHistory = this.toolSurfaceAdapterHistory
      const hooks = this.ports.hookSink.scope({
        sessionId,
        messageId,
        providerId: state.providerId,
        modelId: state.modelId,
        projectDir
      })

      hooks.emit({ event: 'SessionStart', promptPreview })

      let reviewConversationMessages = messages
      const result = await processStream({
        run: loopRun,
        onConversationMessagesChange: (nextMessages) => {
          reviewConversationMessages = nextMessages
        },
        maxProviderRounds,
        providerReplayProjector,
        toolCatalog,
        refreshSystemPrompt: resolveRefreshedPromptAssembly,
        toolExecution: this.ports.toolExecutionPort,
        toolResults: this.ports.toolResultPort,
        programmaticToolParents: this.ports.programmaticToolParents,
        coreStream: async function* (
          requestMessages,
          requestModelId,
          requestModelConfig,
          requestTemperature,
          requestMaxTokens,
          requestTools
        ) {
          const requestBypassesContextBudget = shouldBypassDeepChatContextBudget(
            state.providerId,
            requestModelConfig,
            requestModelId
          )
          const isTtsRequest = isTtsModelConfig(requestModelConfig) || isTtsModelId(requestModelId)
          const effectiveRequestTools: MCPToolDefinition[] = isTtsRequest ? [] : requestTools
          // ACP and non-chat media routes are not safe to replay before their first visible event.
          const allowTransientRetry = !requestBypassesContextBudget && !isTtsRequest
          let queuedForRateLimit = false
          for await (const event of ports.contextCoordinator.streamProviderAttempts({
            run: loopRun,
            requestMessages,
            modelId: requestModelId,
            modelConfig: requestModelConfig,
            temperature: requestTemperature,
            maxTokens: requestMaxTokens,
            tools: effectiveRequestTools,
            allowTransientRetry,
            bypassContextBudget: requestBypassesContextBudget,
            fallbackContextLength: contextBudgetLength,
            supportsVision,
            supportsAudioInput,
            traceDebugEnabled: traceEnabled,
            viewContext,
            ...(toolSurfaceController
              ? {
                  toolSurface: {
                    build: ({ requestSeq, tools: eligibleDefinitions }) => {
                      const viewEligibleDefinitions = programmaticProviderActiveDefinitions
                        ? [
                            ...programmaticProviderActiveDefinitions,
                            ...eligibleDefinitions.filter(
                              (definition) => definition.source === 'mcp'
                            )
                          ]
                        : eligibleDefinitions
                      const snapshot = toolSurfaceController.build({
                        request: {
                          sessionId: loopRun.sessionId,
                          messageId: loopRun.messageId,
                          runId: loopRun.runId,
                          requestSeq
                        },
                        eligibleDefinitions: viewEligibleDefinitions,
                        ...(toolSurfaceMode === 'native-activation'
                          ? { toolSearchAvailable: true }
                          : {})
                      })
                      if (toolSurfaceCanaryEvidence) {
                        bindToolSurfaceCanaryRunEvidence(snapshot, toolSurfaceCanaryEvidence)
                      }
                      return snapshot
                    },
                    ...(toolSurfaceMode === 'cli-programmatic'
                      ? {
                          buildProgrammaticCapability: (snapshot: ToolSurfaceSnapshot) =>
                            buildProgrammaticToolCapabilityV1({
                              snapshot,
                              taskContractContext,
                              ceilings: {
                                maxToolEffect:
                                  taskContractContext?.contract.taskHarness.ceilings.maxToolEffect ??
                                  'write',
                                workspace: projectDir
                                  ? { kind: 'path', path: projectDir }
                                  : { kind: 'runtime_default' },
                                maxSubagentDepth: 0
                              },
                              quotas: {
                                maxChildren: MAX_PROGRAMMATIC_TOOL_CHILDREN,
                                maxBatchSteps: MAX_PROGRAMMATIC_TOOL_BATCH_STEPS,
                                maxInputBytes: MAX_PROGRAMMATIC_TOOL_INPUT_BYTES,
                                maxOutputBytes: MAX_PROGRAMMATIC_TOOL_OUTPUT_BYTES,
                                maxDurationMs: MAX_PROGRAMMATIC_TOOL_DURATION_MS
                              }
                            })
                        }
                      : {}),
                    admit: ({ snapshot }) => {
                      resourceScope.assertCurrent()
                      toolSurfaceController.admit(snapshot)
                      if (
                        automaticToolSurfaceAssignment &&
                        automaticToolSurfaceHistoryScope &&
                        toolSurfaceMode !== 'legacy'
                      ) {
                        toolSurfaceAdapterHistory.record({
                          instance: resourceInstance,
                          scope: automaticToolSurfaceHistoryScope,
                          mode: toolSurfaceMode
                        })
                      }
                    },
                    releaseActivationCandidates: (candidates) => {
                      resourceScope.assertCurrent()
                      toolSurfaceController.stageActivationBatch(candidates)
                    }
                  }
                }
              : {}),
            budget: {
              estimateToolReserveTokens,
              preflight: ({ messages, tools, requestedMaxTokens }) =>
                preflightRequestContext({
                  messages,
                  tools,
                  contextLength: requestModelConfig.contextLength,
                  requestedMaxTokens,
                  contextContributions: activeContextContributions
                }),
              fitStrictRetry: ({ messages, reserveTokens }) =>
                fitRequestMessagesToContextWindow({
                  messages,
                  contextLength: requestModelConfig.contextLength,
                  reserveTokens,
                  minimumProtectedTailCount: 0,
                  contextContributions: activeContextContributions
                }),
              getStrictRetryMaxTokens: getProviderOverflowRetryMaxTokens,
              getStrictRetryExtraReserve: () =>
                getProviderOverflowRetryExtraReserve(requestModelConfig.contextLength),
              buildOverflowError: (preflight) =>
                new Error(buildRequestContextOverflowErrorMessage(preflight)),
              buildOverflowAfterRecoveryError: (preflight) =>
                new Error(buildProviderContextOverflowAfterRecoveryErrorMessage(preflight))
            },
            recovery: {
              recover: async ({ requestMessages, requestedMaxTokens, tools }) =>
                await recoverRequestContextPressure({
                  sessionId,
                  providerId: state.providerId,
                  modelId: requestModelId,
                  requestMessages,
                  baseSystemPrompt:
                    toolSurfaceMode === 'cli-programmatic' ? undefined : baseSystemPrompt,
                  contextLength: requestModelConfig.contextLength,
                  requestedMaxTokens,
                  tools,
                  supportsVision,
                  supportsAudioInput,
                  interleavedReasoning,
                  minimumProtectedTailCount: 0,
                  contextContributions: getOrCreateContextContributions(),
                  signal: abortController.signal,
                  expectedInstance: resourceInstance
                })
            },
            executionContract: strictViewContract
              ? {
                  build: ({
                    requestSeq,
                    messages: providerMessages,
                    modelId: contractModelId,
                    modelConfig: contractModelConfig,
                    temperature: contractTemperature,
                    maxTokens: contractMaxTokens,
                    tools: contractTools,
                    contextBuilderVersion
                  }) => {
                    const effectiveSystemPrompt =
                      providerMessages[0]?.role === 'system' &&
                      typeof providerMessages[0].content === 'string'
                        ? providerMessages[0].content
                        : ''
                    const promptAssembly = reconcilePromptAssembly(
                      loopRun.resources.promptAssembly ??
                        createOpaquePromptAssembly(effectiveSystemPrompt),
                      effectiveSystemPrompt
                    )
                    const cancellationRequested = abortSignal.aborted
                    return buildExecutionContract({
                      request: {
                        sessionId,
                        messageId,
                        runId: loopRun.runId,
                        requestSeq
                      },
                      promptAssembly,
                      providerMessages,
                      tools: contractTools,
                      providerId: state.providerId,
                      modelId: contractModelId,
                      modelConfig: contractModelConfig,
                      temperature: contractTemperature,
                      maxTokens: contractMaxTokens,
                      workspace: projectDir
                        ? { kind: 'path', path: projectDir }
                        : { kind: 'runtime_default' },
                      maxSubagentDepth: resolveExecutionContractSubagentDepth(contractTools),
                      dynamicControlSnapshot: {
                        permissionMode: state.permissionMode,
                        requestAdmitted: !cancellationRequested,
                        cancellationRequested
                      },
                      assemblerVersion: contextBuilderVersion,
                      taskContractContext
                    })
                  },
                  onBuildError: (error) =>
                    logger.warn(
                      `[DeepChatAgent] Failed to construct execution contract: ${
                        error instanceof Error ? error.message : String(error)
                      }`
                    )
                }
              : undefined,
            strictViewContract,
            manifest: {
              resolvePolicy: resolveTapeViewManifestPolicy,
              append: (manifest) =>
                commitTapeProviderView({
                  sessionId,
                  messageId,
                  ...manifest,
                  syntheticContributions: activeContextContributions
                    ? getContextSyntheticContributions(activeContextContributions)
                    : manifest.syntheticContributions,
                  providerId: state.providerId,
                  modelId: requestModelId
                }),
              onAppendError: reportProviderViewProvenanceFailure
            },
            rateGate: {
              beforeWait: crossPreStreamBoundary,
              wait: async (signal) => {
                await ports.providerRuntime.executeWithRateLimit(state.providerId, {
                  signal,
                  onQueued: (snapshot) => {
                    queuedForRateLimit = true
                    emitRateLimitWaitingMessage(
                      sessionId,
                      rateLimitMessageId,
                      activeGeneration.runId,
                      snapshot
                    )
                  }
                })
              },
              clearWaiting: () => {
                if (!queuedForRateLimit) {
                  return
                }
                clearRateLimitWaitingMessage(sessionId, rateLimitMessageId, activeGeneration.runId)
                queuedForRateLimit = false
              }
            },
            provider: {
              stream: ({
                identity,
                messages,
                modelId,
                modelConfig,
                temperature,
                maxTokens,
                tools,
                executionContract,
                toolSurfaceSnapshot,
                signal
              }) => {
                const activeRequestContract = loopRun.activeRequestContract
                if (
                  !activeRequestContract ||
                  activeRequestContract.requestSeq !== identity.requestSeq ||
                  activeRequestContract.executionContract !== executionContract
                ) {
                  throw new Error('Provider request lost its active ExecutionContract binding.')
                }
                if (toolSurfaceController) {
                  resourceScope.assertCurrent()
                  const activeRequestToolSurface = loopRun.activeRequestToolSurface
                  if (
                    !toolSurfaceSnapshot ||
                    !activeRequestToolSurface ||
                    activeRequestToolSurface.requestSeq !== identity.requestSeq ||
                    activeRequestToolSurface.snapshot !== toolSurfaceSnapshot ||
                    tools !== toolSurfaceSnapshot.toolDefinitions
                  ) {
                    throw new Error('Provider request lost its active Tool Surface binding.')
                  }
                } else if (toolSurfaceSnapshot) {
                  throw new Error('Legacy provider request received an unexpected Tool Surface.')
                }
                const attemptModelConfig = traceEnabled
                  ? (Object.assign({}, modelConfig, {
                      requestTraceContext: {
                        enabled: true,
                        persist: async (payload: ProviderRequestTracePayload) => {
                          persistMessageTrace({
                            sessionId,
                            messageId,
                            providerId: state.providerId,
                            modelId: state.modelId,
                            payload,
                            requestSeq: identity.requestSeq,
                            logicalRound: identity.logicalRound,
                            physicalAttempt: identity.physicalAttempt
                          })
                        }
                      } satisfies ProviderRequestTraceContext
                    }) as ModelConfig)
                  : modelConfig
                return ports.providerRuntime.streamChat(
                  state.providerId,
                  messages,
                  modelId,
                  attemptModelConfig,
                  temperature,
                  maxTokens,
                  tools,
                  {
                    signal,
                    ...(search === true ? { search: true } : {})
                  }
                )
              },
              beforeStream: () => {
                if (toolSurfaceController) {
                  resourceScope.assertCurrent()
                }
                crossPreStreamBoundary()
              }
            },
            outcome: {
              append: (outcome) => {
                try {
                  ports.tape.appendProviderAttempt({
                    sessionId,
                    messageId,
                    providerId: state.providerId,
                    modelId: requestModelId,
                    ...outcome
                  })
                } finally {
                  try {
                    if (collectToolSurfaceShadow || toolSurfaceCanaryIdentity !== null) {
                      if (
                        toolSurfaceProviderAttempts.length >=
                        MAX_TOOL_SURFACE_PROVIDER_ATTEMPTS_PER_RUN
                      ) {
                        toolSurfaceProviderAttemptsTruncated = true
                      } else {
                        toolSurfaceProviderAttempts.push({
                          requestSeq: outcome.requestSeq,
                          physicalAttempt: outcome.physicalAttempt,
                          usage: outcome.usage
                            ? {
                                inputTokens: outcome.usage.inputTokens,
                                outputTokens: outcome.usage.outputTokens,
                                ...(outcome.usage.cacheReadTokens === undefined
                                  ? {}
                                  : { cacheReadTokens: outcome.usage.cacheReadTokens }),
                                ...(outcome.usage.cacheWriteTokens === undefined
                                  ? {}
                                  : { cacheWriteTokens: outcome.usage.cacheWriteTokens })
                              }
                            : null
                        })
                      }
                    }
                  } catch {}
                }
              },
              onAppendError: (error) =>
                logger.warn(
                  `[DeepChatAgent] Failed to persist provider attempt outcome: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                )
            },
            retryObserver: (event) => {
              logger.info('[DeepChatAgent] Provider retry lifecycle', {
                sessionId,
                messageId,
                providerId: state.providerId,
                modelId: requestModelId,
                ...event
              })
            },
            isContextOverflowEvent: isFirstProviderContextOverflowEvent,
            isContextOverflowError: isContextWindowErrorLike,
            createAbortError
          })) {
            toolSurfaceFirstProviderEventAt ??= Date.now()
            yield event
          }
        },
        providerId: state.providerId,
        modelId: state.modelId,
        modelConfig,
        temperature,
        maxTokens,
        interleavedReasoning,
        permissionMode: state.permissionMode,
        initialBlocks,
        initialAccounting,
        onFirstProviderRoundReady: () => {
          this.ports.runLifecycle.markFirstTurnReady(resourceScope, activeGeneration.runId)
        },
        shouldYieldForPendingInput: () =>
          Boolean(this.ports.pendingInputCoordinator.getNextSteerInput(sessionId)),
        notificationObserver: hooks.toolObserver(),
        controls: {
          getActiveSkillNames: () => getEffectiveRuntimeSkillNames(),
          getEnabledMcpServerIds: () =>
            this.ports.toolResolver.normalizeNullablePolicyList(
              streamExtensionPolicy.enabledMcpServerIds
            ),
          getAgentId: () =>
            resourceInstance.getAgentId()?.trim() ||
            this.ports.identity.getAgentId(sessionId) ||
            'deepchat',
          ...(toolSurfaceMode === 'native-activation'
            ? {
                prepareSkillActivation: async (skillName: string) => {
                  const requirement = frozenSkillRequirementByName?.get(skillName)
                  const prepareSurface = toolSurfaceController?.prepareSkillActivation
                  if (!requirement?.activatable || !prepareSurface) {
                    return Object.freeze({ kind: 'rejected' as const })
                  }
                  try {
                    const validated = await this.ports.toolResolver.validateSkillNamesForSession(
                      sessionId,
                      [skillName],
                      resourceInstance
                    )
                    abortSignal.throwIfAborted()
                    resourceScope.assertCurrent()
                    if (!validated.includes(skillName)) {
                      return Object.freeze({ kind: 'rejected' as const })
                    }
                    const nextActiveSkillNames = Object.freeze(
                      Array.from(
                        new Set([...getEffectiveRuntimeSkillNames(), skillName])
                      ).sort((left, right) => left.localeCompare(right))
                    )
                    const resolvedTools = await toolCatalog.resolve({
                      activeSkillNames: [...nextActiveSkillNames]
                    })
                    abortSignal.throwIfAborted()
                    resourceScope.assertCurrent()
                    const preparedSurface = prepareSurface({
                      requiredStableTargetKeys: requirement.requiredStableTargetKeys,
                      eligibleDefinitions: resolvedTools
                    })
                    if (preparedSurface.kind === 'rejected') {
                      return Object.freeze({ kind: 'rejected' as const })
                    }
                    const refreshedAssembly = await resolveRefreshedPromptAssembly(
                      [...nextActiveSkillNames],
                      [...preparedSurface.providerActiveDefinitions]
                    )
                    abortSignal.throwIfAborted()
                    resourceScope.assertCurrent()
                    const priorSystemPrompt =
                      loopRun.messages[0]?.role === 'system' &&
                      typeof loopRun.messages[0].content === 'string'
                        ? loopRun.messages[0].content
                        : ''
                    const effectiveSystemPrompt = refreshedAssembly.prompt || priorSystemPrompt
                    const preparedPromptAssembly = reconcilePromptAssembly(
                      refreshedAssembly,
                      effectiveSystemPrompt
                    )
                    let applied = false
                    return Object.freeze({
                      kind: 'prepared' as const,
                      apply: () => {
                        if (applied) return
                        applied = true
                        preparedSurface.apply()
                        resourceInstance.activateRuntimeSkill(skillName)
                        loopRun.resources.activeSkillNames = [...nextActiveSkillNames]
                        loopRun.resources.toolDefinitions = [
                          ...preparedSurface.eligibleDefinitions
                        ]
                        loopRun.resources.promptAssembly = preparedPromptAssembly
                        if (refreshedAssembly.prompt) {
                          if (loopRun.messages[0]?.role === 'system') {
                            loopRun.messages[0] = {
                              ...loopRun.messages[0],
                              content: refreshedAssembly.prompt
                            }
                          } else {
                            loopRun.messages.unshift({
                              role: 'system',
                              content: refreshedAssembly.prompt
                            })
                          }
                        }
                      }
                    })
                  } catch {
                    abortSignal.throwIfAborted()
                    resourceScope.assertCurrent()
                    return Object.freeze({ kind: 'rejected' as const })
                  }
                }
              }
            : {}),
          activateSkill: async (skillName) => {
            const validated = await this.ports.toolResolver.validateSkillNamesForSession(
              sessionId,
              [skillName],
              resourceInstance
            )
            if (!validated.includes(skillName)) {
              return getEffectiveRuntimeSkillNames()
            }
            resourceInstance.activateRuntimeSkill(skillName)
            return getEffectiveRuntimeSkillNames()
          },
          onStreamingProviderPermission: (permission, tool, commitDecision) => {
            this.ports.providerPermissionCoordinator.register(
              sessionId,
              messageId,
              permission,
              tool,
              commitDecision
            )
          },
          autoGrantPermission: async (permission) =>
            await this.ports.sessionPermissionPort.approvePermission(sessionId, permission),
          revokeOneShotCommandPermission: (signature, oneShotGrantId) => {
            this.ports.sessionPermissionPort.revokeOneShotCommandPermission(
              sessionId,
              signature,
              oneShotGrantId
            )
          },
          reviewToolPermission: async (request) =>
            await this.ports.reviewToolPermission(request, {
              providerId: state.providerId,
              modelId: state.modelId,
              messages: reviewConversationMessages.slice(-AUTO_APPROVE_REVIEW_MAX_RECENT_MESSAGES),
              signal: abortController.signal
            }),
          cacheImage: this.ports.cacheImage
        },
        diagnostics: {
          onInterleavedReasoningGap: (gap) => {
            console.warn(
              `[DeepChatAgent] Interleaved reasoning gap detected for ${gap.providerId}/${gap.modelId}. Update provider DB metadata at ${gap.providerDbSourceUrl}.`
            )
            if (!traceEnabled) {
              return
            }
            this.persistMessageTrace({
              sessionId,
              messageId,
              providerId: state.providerId,
              modelId: state.modelId,
              requestSeq: 0,
              payload: {
                endpoint: 'deepchat://interleaved-reasoning-gap',
                headers: {},
                body: gap
              }
            })
          }
        },
        commitRunTerminal,
        io: {
          messageStore: this.ports.messageStore,
          tapeToolFactWriter: this.ports.tape,
          executionJournalWriter: this.ports.tape,
          publishEvent: this.ports.publishEvent,
          publishSessionUpdate: this.ports.publishSessionUpdate
        }
      })
      resourceScope.assertCurrent()
      commitRunTerminal(selectProcessTerminal(result))
      return {
        runId: activeGeneration.runId,
        result
      }
    } catch (error) {
      let errorToPropagate: unknown =
        committedTerminal && !isExecutionJournalError(error)
          ? new CommittedRunProjectionError(loopRun.runId, committedTerminal, { cause: error })
          : error
      try {
        if (!terminalCommitAttempted && resourceScope.isCurrent()) {
          const aborted = abortSignal.aborted
          const fallbackTerminal: ProcessTerminalSelection = {
            outcome: aborted ? 'aborted' : 'error',
            stopReason: aborted
              ? 'user_stop'
              : isContextWindowErrorLike(error)
                ? 'context_window'
                : 'pre_stream_error',
            errorMessage: error instanceof Error ? error.message : String(error)
          }
          commitRunTerminal(fallbackTerminal)
          errorToPropagate = new CommittedRunProjectionError(loopRun.runId, fallbackTerminal, {
            cause: error
          })
        }
      } catch (terminalCommitError) {
        errorToPropagate =
          terminalCommitError === error
            ? error
            : wrapTerminalCommitFailure(error, terminalCommitError)
      } finally {
        this.ports.runLifecycle.clearRun(resourceScope, loopRun.runId)
      }
      throw errorToPropagate
    } finally {
      if (toolSurfaceCanaryIdentity && toolSurfaceMode !== 'legacy') {
        try {
          this.ports.toolSurfaceCanaryDiagnostics.recordRun({
            scope: toolSurfaceCanaryScope,
            adapterMode: toolSurfaceMode,
            ...toolSurfaceCanaryIdentity,
            outcome: readCommittedTerminal()?.outcome ?? 'unsettled',
            durationMs: Math.max(0, Date.now() - toolSurfaceCanaryStartedAt),
            ttftMs:
              toolSurfaceFirstProviderEventAt === null
                ? null
                : Math.max(0, toolSurfaceFirstProviderEventAt - loopRun.streamState.startTime),
            providerRounds: loopRun.logicalRound,
            providerAttempts: toolSurfaceProviderAttempts,
            providerAttemptsTruncated: toolSurfaceProviderAttemptsTruncated,
            evidence:
              toolSurfaceCanaryEvidence?.snapshot() ??
              createToolSurfaceCanaryRunEvidenceRecorder().snapshot()
          })
        } catch {}
      }
      if (
        collectToolSurfaceShadow &&
        toolSurfaceProviderAttempts.length > 0 &&
        !abortSignal.aborted &&
        resourceScope.isCurrent()
      ) {
        try {
          const diagnosticsScope = Object.freeze({
            sessionId,
            providerId: state.providerId,
            modelId: state.modelId,
            toolProfile
          })
          this.ports.toolSurfaceDiagnostics.scheduleDeferredRun({
            instance: resourceInstance,
            scope: diagnosticsScope,
            resolveUniverse: async (signal) =>
              await this.ports.toolResolver.resolveRunToolDefinitionUniverse(
                sessionId,
                projectDir,
                initialRunSkillNames,
                resourceInstance,
                signal
              ),
            isCurrent: () => {
              const currentState = resourceScope.state()
              return (
                !abortSignal.aborted &&
                resourceScope.isCurrent() &&
                currentState?.providerId === diagnosticsScope.providerId &&
                currentState.modelId === diagnosticsScope.modelId &&
                resourceInstance.getToolProfileRevisionToken() === initialToolProfileRevisionToken
              )
            },
            eligibleDefinitions: tools,
            initialViewRequestSeq: loopRun.initialRequestSeq + 1,
            providerAttempts: toolSurfaceProviderAttempts,
            messages
          })
        } catch {}
      }
    }
  }

  commitTapeProviderView(params: CommitTapeProviderViewInput): void {
    const sourceMaps = this.ports.tape.getViewManifestSourceMaps(
      params.sessionId,
      params.messageId
    )
    const selection = params.selection
      ? {
          ...params.selection,
          ...(params.syntheticContributions !== undefined
            ? { syntheticContributions: params.syntheticContributions }
            : {})
        }
      : undefined
    const manifest = createTapeViewManifest({
      sessionId: params.sessionId,
      messageId: params.messageId,
      requestSeq: params.requestSeq,
      taskType: params.taskType,
      policy: params.policy,
      policyVersion: params.policyVersion ?? null,
      contextBuilderVersion: params.contextBuilderVersion,
      messages: params.messages,
      tools: params.tools,
      latestEntryId: sourceMaps.latestEntryId,
      anchorEntryIds: sourceMaps.reconstructionAnchorEntryIds,
      reconstructionAnchorEntryId: sourceMaps.reconstructionAnchorEntryId,
      included: selection
        ? buildIncludedRefs(selection, sourceMaps)
        : [
            ...buildRequestRefs(params.messages, sourceMaps),
            ...buildSyntheticContributionRefs(params.syntheticContributions ?? [])
          ],
      excluded: selection ? buildExcludedRefs(selection, sourceMaps) : [],
      summaryCursor: selection?.summaryCursor,
      tokenBudget: params.tokenBudget,
      providerId: params.providerId,
      modelId: params.modelId,
      summaryCursorOrderSeq: params.summaryCursorOrderSeq,
      supportsVision: params.supportsVision,
      supportsAudioInput: params.supportsAudioInput,
      traceDebugEnabled: params.traceDebugEnabled,
      ...(params.executionContract ? { executionContract: params.executionContract } : {})
    })
    if (!params.toolSurfaceSnapshot) {
      if (params.programmaticToolCapability !== null) {
        throw new Error('A legacy provider View cannot carry a Programmatic capability.')
      }
      this.ports.tape.appendViewManifest(manifest)
      return
    }
    if (
      params.toolSurfaceSnapshot.request.sessionId !== params.sessionId ||
      params.toolSurfaceSnapshot.request.messageId !== params.messageId ||
      params.toolSurfaceSnapshot.request.requestSeq !== params.requestSeq ||
      params.toolSurfaceSnapshot.toolDefinitions !== params.tools
    ) {
      throw new Error('Provider View lost its exact Tool Surface snapshot binding.')
    }
    const projection = projectToolSurfaceTapeProvenance(
      params.toolSurfaceSnapshot,
      params.executionContract !== undefined
    )
    if (params.programmaticToolCapability !== null) {
      assertProgrammaticToolCapabilityViewPrepared(
        params.programmaticToolCapability,
        params.toolSurfaceSnapshot
      )
    }
    this.ports.tape.commitToolSurfaceView({
      manifest,
      activeToolDefinitions: params.tools,
      programmaticSurface:
        params.programmaticToolCapability === null
          ? null
          : projectProgrammaticToolTapeProvenanceV1(params.programmaticToolCapability),
      ...projection
    })
  }

  emitRateLimitWaitingMessage(
    sessionId: string,
    messageId: string,
    requestId: string,
    snapshot: RateLimitQueueSnapshot
  ): void {
    const block: AssistantMessageBlock = {
      type: 'action',
      action_type: 'rate_limit',
      content: '',
      status: 'pending',
      timestamp: Date.now(),
      extra: {
        providerId: snapshot.providerId,
        qpsLimit: snapshot.qpsLimit,
        currentQps: snapshot.currentQps,
        queueLength: snapshot.queueLength,
        estimatedWaitTime: snapshot.estimatedWaitTime
      }
    }

    this.ports.publishEvent('chat.stream.updated', {
      kind: 'snapshot',
      requestId,
      sessionId,
      messageId,
      updatedAt: Date.now(),
      blocks: cloneBlocksForRenderer([block])
    })
  }

  clearRateLimitWaitingMessage(sessionId: string, messageId: string, requestId: string): void {
    this.ports.publishEvent('chat.stream.updated', {
      kind: 'snapshot',
      requestId,
      sessionId,
      messageId,
      updatedAt: Date.now(),
      blocks: []
    })
  }

  private persistMessageTrace(args: {
    sessionId: string
    messageId: string
    providerId: string
    modelId: string
    payload: ProviderRequestTracePayload
    requestSeq?: number
    logicalRound?: number | null
    physicalAttempt?: number | null
  }): void {
    const persistable = buildPersistableMessageTracePayload(args.payload)
    this.ports.messageStore.insertMessageTrace({
      id: nanoid(),
      sessionId: args.sessionId,
      messageId: args.messageId,
      providerId: args.providerId,
      modelId: args.modelId,
      endpoint: persistable.endpoint,
      headersJson: persistable.headersJson,
      bodyJson: persistable.bodyJson,
      truncated: persistable.truncated,
      requestSeq: args.requestSeq,
      logicalRound: args.logicalRound,
      physicalAttempt: args.physicalAttempt
    })
  }

  private async recoverRequestContextPressure(params: {
    sessionId: string
    providerId: string
    modelId: string
    requestMessages: ChatMessage[]
    baseSystemPrompt?: string
    contextLength: number
    requestedMaxTokens: number
    tools: MCPToolDefinition[]
    supportsVision: boolean
    supportsAudioInput: boolean
    interleavedReasoning: InterleavedReasoningConfig
    minimumProtectedTailCount: number
    contextContributions: ContextRuntimeContributions
    signal: AbortSignal
    expectedInstance: DeepChatAgentInstance
  }): Promise<{
    messages: ChatMessage[]
    summaryCursorOrderSeq?: number
    syntheticContributions?: DeepChatTapeViewSyntheticContribution[]
  }> {
    const toolReserveTokens = estimateToolReserveTokens(params.tools)
    return await this.ports.contextCoordinator.recoverFromPressure<SessionSummaryState>({
      requestMessages: params.requestMessages,
      baseSystemPrompt: params.baseSystemPrompt,
      requestedMaxTokens: params.requestedMaxTokens,
      toolReserveTokens,
      minimumProtectedTailCount: params.minimumProtectedTailCount,
      contextContributions: params.contextContributions,
      prepareCompaction: async (systemPrompt) => {
        const prepared = await this.ports.inputPreparationCoordinator.prepareExisting({
          ensureHistory: () =>
            this.ports.tape.ensureSessionTapeReady(
              params.sessionId,
              this.ports.messageStore
            )
              .historyRecords,
          prepareIntent: async (historyRecords) =>
            await this.ports.compactionService.prepareForContextPressureRecovery({
              sessionId: params.sessionId,
              providerId: params.providerId,
              modelId: params.modelId,
              systemPrompt,
              contextLength: params.contextLength,
              reserveTokens: params.requestedMaxTokens,
              extraReserveTokens: toolReserveTokens,
              supportsVision: params.supportsVision,
              supportsAudioInput: params.supportsAudioInput,
              preserveInterleavedReasoning: params.interleavedReasoning.preserveReasoningContent,
              preserveEmptyInterleavedReasoning:
                params.interleavedReasoning.preserveEmptyReasoningContent === true,
              projectedMessages: this.removeLeadingContextContributions(
                params.requestMessages,
                params.contextContributions
              ),
              historyRecords,
              signal: params.signal
            }),
          applyCompaction: async (intent) =>
            await this.ports.compaction.apply(
              params.sessionId,
              intent,
              { signal: params.signal },
              params.expectedInstance
            ),
          readSummary: () => this.ports.sessionStore.getSummaryState(params.sessionId),
          afterCompactionApplyReturned: (intent) =>
            this.ports.memoryIngestionObserver.afterCompactionApplyReturned({
              session: params.expectedInstance.getMemorySessionHandle(),
              origin: 'context-pressure',
              targetCursorOrderSeq: intent.targetCursorOrderSeq
            }),
          checkpoints: {
            assertCurrent: () =>
              this.ports.runLifecycle.assertCurrentInstance(
                params.sessionId,
                params.expectedInstance
              )
          }
        })
        return prepared.intent ? { applied: true, summary: prepared.summary } : { applied: false }
      },
      assembleCheckpoint: async (summaryState) =>
        buildContextCheckpoint(
          summaryState.summaryText,
          this.ports.sessionStore.getReconstructionAnchorPromptState(params.sessionId)
        ),
      getSummaryCursorOrderSeq: (summaryState) => summaryState.summaryCursorOrderSeq,
      fit: ({ messages, reserveTokens, minimumProtectedTailCount }) =>
        fitRequestMessagesToContextWindow({
          messages,
          contextLength: params.contextLength,
          reserveTokens,
          minimumProtectedTailCount,
          contextContributions: params.contextContributions
        }),
      assertCurrent: () =>
        this.ports.runLifecycle.assertCurrentInstance(params.sessionId, params.expectedInstance)
    })
  }

  private removeLeadingContextContributions(
    messages: ChatMessage[],
    context: ContextRuntimeContributions
  ): ChatMessage[] {
    let offset = messages[0]?.role === 'system' ? 1 : 0
    if (
      context.checkpoint.message &&
      messages[offset]?.role === 'user' &&
      messages[offset]?.content === context.checkpoint.message.content
    ) {
      offset += 1
    }
    return messages.slice(offset)
  }
}
