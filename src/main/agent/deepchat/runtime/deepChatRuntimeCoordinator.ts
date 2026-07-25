import type { ProviderModelResolutionPort } from '@/provider/settings'
import logger from '@shared/logger'
import { redactRuntimeErrorForLog } from './runtimeErrorLogging'
import type {
  AssistantMessageBlock,
  DeepChatSessionState,
  MessageMetadata,
  MessageStartResult,
  PendingSessionInputRecord,
  PermissionMode,
  QueuePendingInputOptions,
  SendMessageInput,
  SessionCompactionState,
  SessionAgentContextUpdate,
  SessionGenerationSettings,
  ToolInteractionResponse,
  ToolInteractionResult
} from '@shared/types/agent-interface'
import type { MCPToolResponse } from '@shared/types/core/mcp'
import type { ChatMessage } from '@shared/types/core/chat-message'
import type { SkillServicePort } from '@shared/types/skill'
import type { ProviderExecutionPort } from '@shared/types/provider'
import type { MCPToolDefinition } from '@shared/types/core/mcp'
import type { ToolServicePort } from '@shared/types/tool'
import type { SessionDatabase } from '@/session/data/database'
import type { PromptSettings } from '@/agent/promptSettings'
import type { AgentSettingsPort } from '@/agent/settings'
import { buildSystemPromptWithSkills } from '@/agent/deepchat/resources/systemPromptBuilder'
import { InputPreparationCoordinator } from '@/agent/deepchat/loop/inputPreparationCoordinator'
import { DeepChatContextCoordinator } from '@/agent/deepchat/loop/contextCoordinator'
import { DeepChatLoopRunner, type DeepChatLoopRunInput } from './deepChatLoopRunner'
import type {
  BasePromptAssembler,
  PostCompactionPromptAssembler,
  ToolExecutionPort,
  ToolResultPort
} from '@/agent/deepchat/loop/ports'
import {
  createStaleDeepChatInstanceError,
  DeepChatAgentRuntime,
  isStaleDeepChatInstanceError
} from '@/agent/deepchat/instance/deepChatAgentRuntime'
import {
  MemoryRuntimeCoordinator,
  type MemoryIngestionProjection
} from '@/agent/deepchat/memory/memoryRuntimeCoordinator'
import type { MemoryIngestionObserver } from '@/agent/deepchat/memory/memoryIngestionObserver'
import type { MemoryPromptContributor } from '@/agent/deepchat/memory/memoryPromptContributor'
import type {
  DeepChatAgentInstance,
  DeepChatAgentInstanceDelegate
} from '@/agent/deepchat/instance/deepChatAgentInstance'
import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import { capAgentRequestMaxTokens, estimateToolReserveTokens } from './contextBudget'
import {
  resolveDeepChatContextBudgetLength,
  shouldBypassDeepChatContextBudget
} from './contextBudgetPolicy'
import {
  mapPersistedGenerationPatch,
  resolveInterleavedReasoningConfig,
  sanitizeGenerationSettings,
  type PersistedSessionGenerationRow
} from './generationSettings'
import {
  CompactionService,
  type CompactionIntent
} from './compactionService'
import { buildContextCheckpoint } from './contextContributions'
import { reviewAutoApproveToolPermission } from './toolPermissionReviewer'
import type { SessionData } from '@/session/data'
import type { SessionSummaryState } from '@/session/data/settings'
import type { MemoryRuntimePort } from '@/memory/injection'
import type {
  DeepChatEventPublisher,
  ProcessResult,
  ToolPermissionReviewRequest,
  ToolPermissionReviewResult
} from './types'
import { ToolOutputGuard } from './toolOutputGuard'
import {
  createToolExecutionPort,
  createToolResultPort,
  normalizeToolResultContent
} from './toolAdapters'
import { DeepChatToolResolver } from './toolResolver'
import { DeferredToolExecutor, type DeferredToolExecutionResult } from './deferredToolExecutor'
import { SessionSettingsCoordinator } from './sessionSettingsCoordinator'
import { CompactionRuntimeCoordinator } from './compactionRuntimeCoordinator'
import { ProviderPermissionCoordinator } from './providerPermissionCoordinator'
import { InteractionCoordinator, type ResumeBudgetToolCall } from './interactionCoordinator'
import {
  TurnCoordinator,
  type ProcessPendingInputSource,
  type TurnStartContext
} from './turnCoordinator'
import type { HookObserver } from '@/hook/observer'
import type {
  AcpAsLlmProviderPermissionPort,
  ProviderCatalogPort
} from '@/provider/ports'
import type { SessionPermissionPort, SessionUiPort } from '@/session/contracts'
import { awaitWithAbort } from '@/lib/awaitWithAbort'
import {
  buildAssistantDeliverySegments,
  buildAssistantPreviewMarkdown,
  buildAssistantResponseMarkdown,
  extractWaitingInteraction
} from './sessionUpdates'
import type { DeepChatSessionUpdatePublisher } from './types'
import type { AcpAgentInstanceDependencyFactory } from '@/agent/acp/instance'
import { createAcpCompatibilityDependencies } from '@/agent/acp/compatibility/dependencies'
import type { SkillSettingsPort } from '@/skill/settings'
import type { AgentTraceSettingsPort } from '@/agent/traceSettings'
import { logSlowPreStreamStep } from './preStreamWatchdog'
import {
  resolveProviderInputCapabilities,
  supportsProviderVision
} from './providerInputCapabilities'
import { SessionStatusPublisher } from './sessionStatusPublisher'
import { RunLifecycleCoordinator } from './runLifecycleCoordinator'
import { createAbortError, throwIfAbortRequested } from './abortErrors'
import {
  parseAssistantBlocks
} from './interactionProjection'
import type {
  AttachmentCapabilityRouter,
  AttachmentPreparationResult
} from '@/ocr/attachmentCapabilityRouter'

export {
  PRE_STREAM_STUCK_ESCALATION_MS,
  PRE_STREAM_STUCK_WARN_MS
} from './preStreamWatchdog'

type DeepChatSkillPort = Pick<
  SkillServicePort,
  | 'getMetadataList'
  | 'getActiveSkills'
  | 'resolveSessionAgentId'
  | 'setActiveSkills'
  | 'revalidateActiveSkillsForAgent'
  | 'validateSkillNames'
  | 'loadSkillContent'
  | 'viewDraftSkill'
  | 'installDraftSkill'
  | 'discardDraftSkill'
>

export interface DeepChatRuntimeDependencies {
  publishEvent: DeepChatEventPublisher
  publishSessionUpdate: DeepChatSessionUpdatePublisher
  providerCatalogPort: Pick<ProviderCatalogPort, 'getProviderModels' | 'getCustomModels'>
  sessionPermissionPort: SessionPermissionPort
  acpAsLlmProviderPermission: AcpAsLlmProviderPermissionPort
  sessionUiPort: SessionUiPort
  memoryPort: MemoryRuntimePort
  getMemoryIngestionProjection(): MemoryIngestionProjection
  cacheImage(data: string): Promise<string>
  skillService: DeepChatSkillPort
  skillSettings: SkillSettingsPort
  traceSettings: AgentTraceSettingsPort
  promptSettings: Pick<PromptSettings, 'getDefaultSystemPrompt'>
  attachmentRouter: Pick<AttachmentCapabilityRouter, 'prepare'>
}

export class DeepChatRuntimeCoordinator {
  private readonly providerRuntime: ProviderExecutionPort
  private readonly providerSettings: ProviderModelResolutionPort
  private readonly agentSettings: AgentSettingsPort
  private readonly sqlitePresenter: SessionDatabase
  private readonly toolService: ToolServicePort
  private readonly sessionStore: SessionData['settings']
  private readonly messageStore: SessionData['transcript']
  private readonly tapeService: SessionData['tapeStore']
  private readonly pendingInputCoordinator: SessionData['pendingInputs']
  readonly deepChatRuntime: DeepChatAgentRuntime
  private readonly toolResolver: DeepChatToolResolver
  private readonly sessionSettingsCoordinator: SessionSettingsCoordinator
  private readonly providerPermissionCoordinator: ProviderPermissionCoordinator
  private readonly compactionService: CompactionService
  private readonly compactionRuntimeCoordinator: CompactionRuntimeCoordinator
  private readonly inputPreparationCoordinator = new InputPreparationCoordinator()
  private readonly contextCoordinator = new DeepChatContextCoordinator()
  private readonly toolOutputGuard: ToolOutputGuard
  private readonly toolExecutionPort: ToolExecutionPort
  private readonly toolResultPort: ToolResultPort
  private readonly deferredToolExecutor: DeferredToolExecutor
  private readonly loopRunner: DeepChatLoopRunner
  private readonly turnCoordinator: TurnCoordinator
  private readonly interactionCoordinator: InteractionCoordinator
  private readonly hookObserver: HookObserver
  private readonly providerCatalogPort: Pick<
    ProviderCatalogPort,
    'getProviderModels' | 'getCustomModels'
  >
  private readonly sessionPermissionPort: SessionPermissionPort
  private readonly acpAsLlmProviderPermission: AcpAsLlmProviderPermissionPort
  private readonly sessionStatusPublisher: SessionStatusPublisher
  private readonly runLifecycle: RunLifecycleCoordinator
  private readonly memoryCoordinator: MemoryRuntimeCoordinator
  private readonly memoryPromptContributor: MemoryPromptContributor
  readonly memoryIngestionObserver: MemoryIngestionObserver
  private readonly cacheImage: (data: string) => Promise<string>
  private readonly skillService: DeepChatSkillPort
  private readonly skillSettings: SkillSettingsPort
  private readonly traceSettings: AgentTraceSettingsPort
  private readonly promptSettings: Pick<PromptSettings, 'getDefaultSystemPrompt'>
  private readonly publishEvent: DeepChatEventPublisher
  private readonly publishSessionUpdate: DeepChatSessionUpdatePublisher
  private readonly postCompactionPromptAssembler: PostCompactionPromptAssembler
  private readonly attachmentRouter: Pick<AttachmentCapabilityRouter, 'prepare'>
  // OCR preflight is asynchronous; admission lanes keep completion timing from reordering inputs.
  private readonly attachmentAcceptanceTails = new Map<string, Promise<void>>()

  constructor(
    providerRuntime: ProviderExecutionPort,
    providerSettings: ProviderModelResolutionPort,
    agentSettings: AgentSettingsPort,
    sqlitePresenter: SessionDatabase,
    sessionData: SessionData,
    toolService: ToolServicePort,
    runtimePorts: DeepChatRuntimeDependencies,
    hookObserver: HookObserver
  ) {
    this.providerRuntime = providerRuntime
    this.providerSettings = providerSettings
    this.agentSettings = agentSettings
    this.sqlitePresenter = sqlitePresenter
    this.toolService = toolService
    this.hookObserver = hookObserver
    this.providerCatalogPort = runtimePorts.providerCatalogPort
    this.sessionPermissionPort = runtimePorts.sessionPermissionPort
    this.acpAsLlmProviderPermission = runtimePorts.acpAsLlmProviderPermission
    this.cacheImage = runtimePorts.cacheImage
    this.skillService = runtimePorts.skillService
    this.skillSettings = runtimePorts.skillSettings
    this.traceSettings = runtimePorts.traceSettings
    this.promptSettings = runtimePorts.promptSettings
    this.publishEvent = runtimePorts.publishEvent
    this.publishSessionUpdate = runtimePorts.publishSessionUpdate
    this.attachmentRouter = runtimePorts.attachmentRouter
    this.sessionStore = sessionData.settings
    this.messageStore = sessionData.transcript
    this.tapeService = sessionData.tapeStore
    this.pendingInputCoordinator = sessionData.pendingInputs
    this.deepChatRuntime = new DeepChatAgentRuntime((sessionId) =>
      this.createDeepChatInstanceDelegate(sessionId)
    )
    this.sessionStatusPublisher = new SessionStatusPublisher({
      publishEvent: this.publishEvent,
      publishSessionUpdate: this.publishSessionUpdate,
      sessionUiPort: runtimePorts.sessionUiPort
    })
    this.runLifecycle = new RunLifecycleCoordinator({
      runtime: this.deepChatRuntime,
      statusPublisher: this.sessionStatusPublisher,
      transcript: this.messageStore,
      emitMessageRefresh: (sessionId, messageId) =>
        this.emitMessageRefresh(sessionId, messageId),
      terminalObserver: {
        observe: (sessionId, state, result) =>
          this.dispatchTerminalHooks(sessionId, state, result)
      },
      pendingInputWakeup: {
        drain: async (sessionId, reason) =>
          await this.drainPendingQueueIfPossible(sessionId, reason)
      }
    })
    this.toolResolver = new DeepChatToolResolver({
      agentSettings: this.agentSettings,
      skillSettings: this.skillSettings,
      sqlitePresenter: this.sqlitePresenter,
      toolService: this.toolService,
      skillService: this.skillService,
      deepChatRuntime: this.deepChatRuntime,
      getDeepChatInstance: (sessionId) => this.getDeepChatInstance(sessionId),
      getSessionAgentId: (sessionId) => this.getSessionAgentId(sessionId),
      getRuntimeState: (sessionId) => this.getDeepChatRuntimeState(sessionId),
      assertCurrent: (sessionId, instance) =>
        this.throwIfStaleDeepChatInstance(sessionId, instance),
      isAcpBackedSubagentSession: (sessionId, providerId) =>
        this.isAcpBackedSubagentSession(sessionId, providerId),
      isStaleInstanceError: (error) => this.isStaleDeepChatInstanceError(error)
    })
    this.sessionSettingsCoordinator = new SessionSettingsCoordinator({
      providerSettings: this.providerSettings,
      promptSettings: this.promptSettings,
      sessionStore: this.sessionStore,
      toolResolver: this.toolResolver,
      toolService: this.toolService,
      sessionPermissionPort: this.sessionPermissionPort,
      getRuntimeState: (sessionId) => this.getDeepChatRuntimeState(sessionId),
      getSessionAgentId: (sessionId) => this.getSessionAgentId(sessionId),
      getInstance: (sessionId) => this.getDeepChatInstance(sessionId),
      beginSessionAgentReassignment: async (sessionId) =>
        await this.memoryCoordinator.beginSessionAgentReassignment(sessionId),
      finishSessionAgentReassignment: (sessionId) =>
        this.memoryCoordinator.finishSessionAgentReassignment(sessionId),
      getEffectiveGenerationSettings: async (sessionId) =>
        await this.getEffectiveSessionGenerationSettings(sessionId),
      normalizeProjectDir: (projectDir) => this.normalizeProjectDir(projectDir),
      resolvePersistedProjectDir: (sessionId) => this.resolvePersistedSessionProjectDir(sessionId),
      invalidateToolProfileCache: (sessionId) => this.invalidateToolProfileCache(sessionId)
    })
    this.providerPermissionCoordinator = new ProviderPermissionCoordinator({
      publishEvent: this.publishEvent,
      messageStore: this.messageStore,
      runLifecycle: this.runLifecycle,
      permissionPort: this.acpAsLlmProviderPermission,
      emitMessageRefresh: (sessionId, messageId) => this.emitMessageRefresh(sessionId, messageId)
    })
    this.memoryCoordinator = new MemoryRuntimeCoordinator({
      memoryPort: runtimePorts.memoryPort,
      getSessionAgentId: (sessionId) => this.getSessionAgentId(sessionId),
      getSessionRuntimeState: (sessionId) => this.getDeepChatRuntimeState(sessionId),
      hasSessionRuntimeState: (sessionId) => Boolean(this.getDeepChatRuntimeState(sessionId)),
      assertCurrentSessionHandle: (handle) => {
        const sessionId = handle.sessionId
        if (this.getHydratedDeepChatInstance(sessionId)?.getMemorySessionHandle() !== handle) {
          throw createStaleDeepChatInstanceError(sessionId)
        }
      },
      getNextMessageOrderSeq: (sessionId) => this.messageStore.getNextOrderSeq(sessionId),
      getMessagesUpToOrderSeq: (sessionId, orderSeq) =>
        this.messageStore.getMessagesUpToOrderSeq(sessionId, orderSeq),
      getMemoryCursorOrderSeq: (sessionId) =>
        this.sqlitePresenter.deepchatSessionsTable.getMemoryCursorOrderSeq(sessionId),
      updateMemoryCursorOrderSeq: (sessionId, orderSeq) =>
        this.sqlitePresenter.deepchatSessionsTable.updateMemoryCursorOrderSeq(sessionId, orderSeq),
      rewindMemoryCursorOrderSeq: (sessionId, orderSeq) =>
        this.sqlitePresenter.deepchatSessionsTable.rewindMemoryCursorOrderSeq(sessionId, orderSeq),
      tapeReader: this.tapeService,
      tapeAnchorWriter: this.tapeService,
      getIngestionProjection: runtimePorts.getMemoryIngestionProjection
    })
    this.memoryPromptContributor = this.memoryCoordinator
    this.memoryIngestionObserver = this.memoryCoordinator
    this.postCompactionPromptAssembler = {
      assemble: async (input) => {
        const memory = await this.memoryPromptContributor.contribute({
          session: input.memorySession,
          query: input.memoryQuery,
          messageId: input.memoryMessageId
        })
        return {
          checkpoint: buildContextCheckpoint(input.summaryText, input.reconstructionAnchor),
          memory,
          memoryIncluded: Boolean(memory.content)
        }
      }
    }
    this.compactionService = new CompactionService(
      this.sessionStore,
      this.messageStore,
      this.providerRuntime,
      this.providerSettings,
      async (sessionId) => {
        const agentId = this.getSessionAgentId(sessionId) ?? 'deepchat'
        return await this.agentSettings.resolveDeepChatAgentConfig(agentId)
      }
    )
    this.compactionRuntimeCoordinator = new CompactionRuntimeCoordinator({
      publishEvent: this.publishEvent,
      compactionService: this.compactionService,
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      getInstance: (sessionId) => this.getDeepChatInstance(sessionId),
      assertCurrent: (sessionId, instance) =>
        this.throwIfStaleDeepChatInstance(sessionId, instance),
      emitMessageRefresh: (sessionId, messageId) => this.emitMessageRefresh(sessionId, messageId)
    })
    this.toolOutputGuard = new ToolOutputGuard()
    this.toolExecutionPort = createToolExecutionPort(this.toolService)
    this.toolResultPort = createToolResultPort({
      outputGuard: this.toolOutputGuard,
      normalize: async (tool) =>
        await this.normalizeToolResultContent({
          sessionId: tool.sessionId,
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          toolArgs: tool.toolArgs,
          content: tool.content,
          isError: tool.isError,
          abortSignal: tool.signal
        })
    })
    this.deferredToolExecutor = new DeferredToolExecutor({
      toolExecutionPort: this.toolExecutionPort,
      toolResultPort: this.toolResultPort,
      toolResolver: this.toolResolver,
      cacheImage: this.cacheImage,
      registerAbortController: (sessionId, toolCallId) =>
        this.runLifecycle.registerDeferredToolController(sessionId, toolCallId),
      clearAbortController: (sessionId, toolCallId, controller) =>
        this.runLifecycle.clearDeferredToolController(sessionId, toolCallId, controller),
      getAbortSignal: (sessionId) => this.runLifecycle.getAbortSignal(sessionId),
      resolveProjectDir: (sessionId) => this.resolveProjectDir(sessionId),
      getSessionState: async (sessionId) => await this.getSessionState(sessionId),
      getSessionAgentId: (sessionId) => this.getSessionAgentId(sessionId),
      updateSubagentProgress: (...args) => this.updateSubagentToolCallProgress(...args)
    })
    this.loopRunner = new DeepChatLoopRunner({
      publishEvent: this.publishEvent,
      publishSessionUpdate: this.publishSessionUpdate,
      providerRuntime: this.providerRuntime,
      providerSettings: this.providerSettings,
      traceSettings: this.traceSettings,
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      tapeReconciliation: this.tapeService,
      tapeViewManifestReader: this.tapeService,
      tapeViewManifestWriter: this.tapeService,
      tapeProviderAttemptReader: this.tapeService,
      tapeProviderAttemptWriter: this.tapeService,
      tapeToolFactWriter: this.tapeService,
      pendingInputCoordinator: this.pendingInputCoordinator,
      toolResolver: this.toolResolver,
      providerPermissionCoordinator: this.providerPermissionCoordinator,
      compactionService: this.compactionService,
      inputPreparationCoordinator: this.inputPreparationCoordinator,
      contextCoordinator: this.contextCoordinator,
      memoryIngestionObserver: this.memoryIngestionObserver,
      toolExecutionPort: this.toolExecutionPort,
      toolResultPort: this.toolResultPort,
      cacheImage: this.cacheImage,
      runLifecycle: this.runLifecycle,
      getDeepChatInstance: (sessionId) => this.getDeepChatInstance(sessionId),
      getEffectiveSessionGenerationSettings: async (sessionId, instance) =>
        await this.getEffectiveSessionGenerationSettings(sessionId, instance),
      createBasePromptAssembler: (instance) => this.createBasePromptAssembler(instance),
      getSessionAgentId: (sessionId) => this.getSessionAgentId(sessionId),
      sessionPermissionPort: this.sessionPermissionPort,
      reviewToolPermission: async (request, context) =>
        await this.reviewToolPermissionForAutoApprove(request, context),
      dispatchHook: (event, context) => this.dispatchHook(event, context),
      applyCompactionIntent: async (sessionId, intent, options, instance) =>
        await this.applyCompactionIntent(sessionId, intent, options, instance)
    })
    this.turnCoordinator = new TurnCoordinator({
      publishEvent: this.publishEvent,
      providerSettings: this.providerSettings,
      traceSettings: this.traceSettings,
      toolService: this.toolService,
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      tapeReconciliation: this.tapeService,
      pendingInputCoordinator: this.pendingInputCoordinator,
      toolResolver: this.toolResolver,
      compactionService: this.compactionService,
      compactionRuntimeCoordinator: this.compactionRuntimeCoordinator,
      inputPreparationCoordinator: this.inputPreparationCoordinator,
      contextCoordinator: this.contextCoordinator,
      memoryCoordinator: this.memoryCoordinator,
      memoryIngestionObserver: this.memoryIngestionObserver,
      postCompactionPromptAssembler: this.postCompactionPromptAssembler,
      toolOutputGuard: this.toolOutputGuard,
      runLifecycle: this.runLifecycle,
      getDeepChatInstance: (sessionId) => this.getDeepChatInstance(sessionId),
      getHydratedDeepChatInstance: (sessionId) => this.getHydratedDeepChatInstance(sessionId),
      prepareAttachments: async (input) => await this.attachmentRouter.prepare(input),
      resolveProjectDir: (sessionId, projectDir, instance) =>
        this.resolveProjectDir(sessionId, projectDir, instance),
      getEffectiveSessionGenerationSettings: async (sessionId, instance) =>
        await this.getEffectiveSessionGenerationSettings(sessionId, instance),
      createBasePromptAssembler: (instance) => this.createBasePromptAssembler(instance),
      runStreamForMessage: async (args) => await this.runStreamForMessage(args),
      emitMessageRefresh: (sessionId, messageId) => this.emitMessageRefresh(sessionId, messageId),
      dispatchHook: (event, context) => this.dispatchHook(event, context)
    })
    this.interactionCoordinator = new InteractionCoordinator({
      publishEvent: this.publishEvent,
      messageStore: this.messageStore,
      providerPermissionCoordinator: this.providerPermissionCoordinator,
      skillService: this.skillService,
      runLifecycle: this.runLifecycle,
      getDeepChatInstance: (sessionId) => this.getDeepChatInstance(sessionId),
      getRuntimeState: (sessionId) => this.getDeepChatRuntimeState(sessionId),
      resolveProjectDir: (sessionId) => this.resolveProjectDir(sessionId),
      sessionPermissionPort: this.sessionPermissionPort,
      executeDeferredToolCall: async (...args) => await this.executeDeferredToolCall(...args),
      emitMessageRefresh: (sessionId, messageId) => this.emitMessageRefresh(sessionId, messageId),
      dispatchHook: (event, context) => this.dispatchHook(event, context),
      resumeAssistantMessage: async (...args) => await this.resumeAssistantMessage(...args)
    })
    const recovered = this.messageStore.recoverPendingMessages()
    if (recovered > 0) {
      logger.info(`DeepChatAgent: recovered ${recovered} pending messages to error status`)
    }

    const recoveredPendingInputs = this.pendingInputCoordinator.recoverClaimedInputsAfterRestart()
    if (recoveredPendingInputs > 0) {
      logger.info(
        `DeepChatAgent: recovered ${recoveredPendingInputs} sessions with claimed pending inputs`
      )
    }

  }

  refreshToolRegistry(): void {
    this.handleToolRegistryChanged()
  }

  createAcpAgentInstanceDependencies(
    input: Parameters<AcpAgentInstanceDependencyFactory>[0]
  ): ReturnType<AcpAgentInstanceDependencyFactory> {
    return createAcpCompatibilityDependencies(
      {
        publishEvent: this.publishEvent,
        publishSessionUpdate: this.publishSessionUpdate,
        providerSettings: this.providerSettings,
        traceSettings: this.traceSettings,
        providerRuntime: this.providerRuntime,
        sessionStore: this.sessionStore,
        messageStore: this.messageStore,
        tapeReconciliation: this.tapeService,
        toolResolver: this.toolResolver,
        appendViewManifest: (manifest) => {
          this.loopRunner.appendTapeViewManifest({
            sessionId: manifest.sessionId,
            messageId: manifest.messageId,
            requestSeq: manifest.requestSeq,
            taskType: manifest.taskType,
            policy: manifest.policy,
            policyVersion: manifest.policyVersion,
            contextBuilderVersion: 'legacy-v1',
            messages: manifest.messages,
            tools: manifest.localToolDefinitions,
            tokenBudget: manifest.tokenBudget,
            providerId: manifest.providerId,
            modelId: manifest.modelId,
            summaryCursorOrderSeq: manifest.summaryCursorOrderSeq,
            supportsVision: manifest.supportsVision,
            supportsAudioInput: manifest.supportsAudioInput,
            traceDebugEnabled: manifest.traceDebugEnabled
          })
        },
        setStatus: (sessionId, status) =>
          this.runLifecycle.transitionCurrentStatus(sessionId, status),
        getSessionState: async (sessionId) => await this.getSessionState(sessionId),
        getDeepChatInstance: (sessionId) => this.getDeepChatInstance(sessionId),
        getGenerationSettings: async (sessionId, instance) =>
          await this.getEffectiveSessionGenerationSettings(sessionId, instance),
        buildSystemPrompt: async (sessionId, basePrompt, tools, activeSkills, instance) =>
          await this.buildSystemPromptWithSkills(
            sessionId,
            basePrompt,
            tools,
            activeSkills,
            instance
          ),
        emitRateLimitWaitingMessage: (sessionId, messageId, requestId, snapshot) =>
          this.loopRunner.emitRateLimitWaitingMessage(sessionId, messageId, requestId, snapshot),
        clearRateLimitWaitingMessage: (sessionId, messageId, requestId) =>
          this.loopRunner.clearRateLimitWaitingMessage(sessionId, messageId, requestId),
        dispatchHook: (event, context) => this.dispatchHook(event, context)
      },
      input
    )
  }

  private getDeepChatInstance(sessionId: string): DeepChatAgentInstance {
    return this.deepChatRuntime.getOrHydrate(toAppSessionId(sessionId))
  }

  private getHydratedDeepChatInstance(sessionId: string): DeepChatAgentInstance | undefined {
    return this.deepChatRuntime.getHydrated(toAppSessionId(sessionId))
  }

  private getDeepChatRuntimeState(sessionId: string): DeepChatSessionState | undefined {
    return this.getHydratedDeepChatInstance(sessionId)?.getRuntimeState()
  }

  private createBasePromptAssembler(expectedInstance: DeepChatAgentInstance): BasePromptAssembler {
    return {
      assemble: async (input) =>
        await this.buildSystemPromptWithSkills(
          input.sessionId,
          input.configuredPrompt,
          [...input.toolDefinitions],
          [...input.activeSkillNames],
          expectedInstance
        )
    }
  }

  private throwIfStaleDeepChatInstance(
    sessionId: string,
    expectedInstance: DeepChatAgentInstance
  ): void {
    this.runLifecycle.assertCurrentInstance(sessionId, expectedInstance)
  }

  private isStaleDeepChatInstanceError(error: unknown): boolean {
    return isStaleDeepChatInstanceError(error)
  }

  private createDeepChatInstanceDelegate(sessionId: string): DeepChatAgentInstanceDelegate {
    return {
      send: async (input) => {
        if (input.queue) {
          return await this.sendQueuedMessage(sessionId, input.content, input.queue, input.context)
        }
        return await this.processMessage(sessionId, input.content, input.context)
      },
      cancel: async () => await this.cancelGeneration(sessionId),
      snapshot: async (options) =>
        options?.lightweight
          ? await this.getSessionListState(sessionId)
          : await this.getSessionState(sessionId),
      close: async () => await this.destroySession(sessionId)
    }
  }

  private async reviewToolPermissionForAutoApprove(
    request: ToolPermissionReviewRequest,
    context: {
      providerId: string
      modelId: string
      messages: ChatMessage[]
      signal: AbortSignal
    }
  ): Promise<ToolPermissionReviewResult> {
    return await reviewAutoApproveToolPermission(
      {
        providerSettings: this.providerSettings,
        agentSettings: this.agentSettings,
        providerRuntime: this.providerRuntime,
        getSessionAgentId: (sessionId) => this.getSessionAgentId(sessionId)
      },
      request,
      context
    )
  }

  async initSession(
    sessionId: string,
    config: {
      agentId?: string
      providerId: string
      modelId: string
      projectDir?: string | null
      permissionMode?: PermissionMode
      generationSettings?: Partial<SessionGenerationSettings>
    }
  ): Promise<void> {
    const projectDir = this.normalizeProjectDir(config.projectDir)
    const permissionMode = config.permissionMode ?? 'default'
    logger.info(
      `[DeepChatAgent] initSession id=${sessionId} provider=${config.providerId} model=${config.modelId} permission=${permissionMode} hasProjectDir=${projectDir !== null}`
    )
    const generationSettings = await sanitizeGenerationSettings(
      this.providerSettings,
      this.promptSettings,
      config.providerId,
      config.modelId,
      config.generationSettings ?? {}
    )
    this.sessionStore.create(
      sessionId,
      config.providerId,
      config.modelId,
      permissionMode,
      generationSettings
    )
    const instance = this.getDeepChatInstance(sessionId)
    instance.setAgentId(config.agentId?.trim() || this.getSessionAgentId(sessionId) || 'deepchat')
    instance.setProjectDir(projectDir)
    instance.setGenerationSettings(generationSettings)
    instance.setRuntimeState({
      status: 'idle',
      providerId: config.providerId,
      modelId: config.modelId,
      permissionMode
    })
    instance.setCompactionState(this.compactionRuntimeCoordinator.idleState())
    this.memoryCoordinator.initializeSession(sessionId)
    this.runLifecycle.clearFirstTurnReady(sessionId)
    this.invalidateToolProfileCache(sessionId)
  }

  async destroySession(sessionId: string): Promise<void> {
    const instance = this.getHydratedDeepChatInstance(sessionId)
    this.memoryCoordinator.beginSessionDestroy(sessionId)
    if (instance) {
      this.runLifecycle.cancelScopeOperations(this.runLifecycle.scopeFor(sessionId, instance))
    }
    this.runLifecycle.clearFirstTurnReady(sessionId)

    this.pendingInputCoordinator.deleteBySession(sessionId)
    this.messageStore.deleteBySession(sessionId)
    this.sessionStore.delete(sessionId)
    instance?.clearOwnedState()
    this.deepChatRuntime.evict(toAppSessionId(sessionId))
    this.memoryCoordinator.finishSessionDestroy(sessionId)
    this.toolService.clearConversationToolMapping(sessionId)
  }

  async getSessionState(sessionId: string): Promise<DeepChatSessionState | null> {
    return await this.getResolvedSessionState(sessionId, 'full')
  }

  async getSessionListState(sessionId: string): Promise<DeepChatSessionState | null> {
    return await this.getResolvedSessionState(sessionId, 'summary')
  }

  private async getResolvedSessionState(
    sessionId: string,
    hydrationMode: 'full' | 'summary'
  ): Promise<DeepChatSessionState | null> {
    const instance = this.getDeepChatInstance(sessionId)
    const state = instance.getRuntimeState()
    if (state) {
      this.getSessionAgentId(sessionId)
      if (hydrationMode === 'full') {
        await this.getEffectiveSessionGenerationSettings(sessionId)
      }
      return {
        ...state,
        ...(this.runLifecycle.hasPendingInteractions(sessionId)
          ? { status: 'generating' as const }
          : {})
      }
    }

    const dbSession = this.sessionStore.get(sessionId) as PersistedSessionGenerationRow | undefined
    if (!dbSession) {
      this.deepChatRuntime.evict(toAppSessionId(sessionId))
      return null
    }

    this.getSessionAgentId(sessionId)
    const hasPendingInteractions = this.runLifecycle.hasPendingInteractions(sessionId)
    const rebuilt: DeepChatSessionState = {
      status: 'idle',
      providerId: dbSession.provider_id,
      modelId: dbSession.model_id,
      permissionMode: dbSession.permission_mode
    }
    instance.setRuntimeState(rebuilt)
    if (hydrationMode === 'full') {
      await this.getEffectiveSessionGenerationSettings(sessionId)
    }
    return {
      ...rebuilt,
      ...(hasPendingInteractions ? { status: 'generating' as const } : {})
    }
  }

  async listPendingInputs(sessionId: string): Promise<PendingSessionInputRecord[]> {
    return this.pendingInputCoordinator.listPendingInputs(sessionId)
  }

  async waitForFirstTurnReady(
    sessionId: string,
    options?: { timeoutMs?: number }
  ): Promise<boolean> {
    return await this.getDeepChatInstance(sessionId).waitForFirstTurnReady(options)
  }

  async queuePendingInput(
    sessionId: string,
    content: string | SendMessageInput,
    options?: QueuePendingInputOptions
  ): Promise<PendingSessionInputRecord> {
    const state = await this.getSessionState(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }
    const projectDir =
      options && Object.prototype.hasOwnProperty.call(options, 'projectDir')
        ? this.resolveProjectDir(sessionId, options.projectDir)
        : this.resolveProjectDir(sessionId)
    const input = typeof content === 'string' ? { text: content, files: [] } : content
    if (options?.signal?.aborted) throw createAbortError()
    if (!input.text.trim() && (input.files?.length ?? 0) === 0) {
      throw new Error('Message cannot be empty.')
    }

    const shouldClaimImmediately =
      ((options?.source ?? 'send') === 'send' &&
        this.isAwaitingToolQuestionFollowUp(sessionId) &&
        !this.pendingInputCoordinator.hasBlockingInput(sessionId) &&
        !this.pendingInputCoordinator.hasClaimedInput(sessionId)) ||
      this.shouldStartQueuedInputImmediately(sessionId, state.status)
    const record = this.pendingInputCoordinator.queuePendingInput(sessionId, input, {
      state: shouldClaimImmediately ? 'claimed' : 'pending'
    })

    if (record.state === 'claimed') {
      void this.processMessage(sessionId, record.payload, {
        projectDir,
        pendingQueueItemId: record.id,
        pendingQueueItemSource: options?.source ?? 'send'
      }).catch((error) => {
        console.error('[DeepChatAgent] queuePendingInput process error:', error)
      })
      return record
    }

    this.runLifecycle.schedulePendingInputDrain(sessionId, 'enqueue')
    return record
  }

  private async sendQueuedMessage(
    sessionId: string,
    content: SendMessageInput,
    options: QueuePendingInputOptions,
    context?: { signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    if ((options.source ?? 'send') !== 'send') {
      await this.queuePendingInput(sessionId, content, {
        ...options,
        signal: context?.signal
      })
      return { requestId: null, messageId: null }
    }

    const releaseAcceptanceLane = await this.acquireAttachmentAcceptanceLane(
      sessionId,
      'send',
      context?.signal
    )
    try {
      if (this.pendingInputCoordinator.isAtCapacity(sessionId)) {
        throw new Error('Pending input limit reached for this session.')
      }

      const prepared = await this.prepareMessageInputNow(sessionId, content, {
        signal: context?.signal
      })
      if (prepared.summary.status === 'needs_user_action') {
        return {
          requestId: null,
          messageId: null,
          attachmentPreparation: prepared.summary
        }
      }

      if (context?.signal?.aborted) throw createAbortError()

      await this.queuePendingInput(sessionId, prepared.content, {
        ...options,
        signal: context?.signal
      })
      return {
        requestId: null,
        messageId: null,
        attachmentPreparation: prepared.summary
      }
    } finally {
      releaseAcceptanceLane()
    }
  }

  private async acquireAttachmentAcceptanceLane(
    sessionId: string,
    lane: 'send' | 'steer',
    signal?: AbortSignal
  ): Promise<() => void> {
    const key = `${lane}:${sessionId}`
    const previous = this.attachmentAcceptanceTails.get(key) ?? Promise.resolve()
    let resolveSlot!: () => void
    const slot = new Promise<void>((resolve) => {
      resolveSlot = resolve
    })
    const tail = previous.then(
      () => slot,
      () => slot
    )
    this.attachmentAcceptanceTails.set(key, tail)

    let released = false
    const release = () => {
      if (released) return
      released = true
      resolveSlot()
      void tail.then(() => {
        if (this.attachmentAcceptanceTails.get(key) === tail) {
          this.attachmentAcceptanceTails.delete(key)
        }
      })
    }
    try {
      await awaitWithAbort(previous, signal)
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  private async prepareMessageInputNow(
    sessionId: string,
    content: SendMessageInput,
    options?: {
      preserveResolvedRepresentations?: boolean
      signal?: AbortSignal
    }
  ): Promise<AttachmentPreparationResult> {
    const state = await this.getSessionState(sessionId)
    if (!state) throw new Error(`Session ${sessionId} not found`)
    return await this.attachmentRouter.prepare({
      content,
      supportsVision: supportsProviderVision(
        this.providerSettings,
        state.providerId,
        state.modelId
      ),
      signal: options?.signal,
      preserveResolvedRepresentations: options?.preserveResolvedRepresentations,
      // This is an acceptance preflight. The dispatch-time pass records the representation that
      // actually reaches the provider after any queued model or setting changes.
      emitDiagnostics: false
    })
  }

  async steerActiveTurn(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    const input = typeof content === 'string' ? { text: content, files: [] } : content
    // Text-only steers retain their existing fast coalescing path unless an earlier attachment
    // steer is still being accepted. In that case they join the lane so OCR completion cannot
    // reverse the user's input order.
    const hasPriorSteerAcceptance = this.attachmentAcceptanceTails.has(`steer:${sessionId}`)
    const releaseAcceptanceLane =
      input.files?.length || hasPriorSteerAcceptance
        ? await this.acquireAttachmentAcceptanceLane(sessionId, 'steer', options?.signal)
        : () => {}
    try {
      const state = await this.getSessionState(sessionId)
      if (!state) {
        throw new Error(`Session ${sessionId} not found`)
      }
      if (
        this.isAwaitingToolQuestionFollowUp(sessionId) ||
        this.runLifecycle.hasPendingInteractions(sessionId)
      ) {
        throw new Error('Please resolve pending tool interactions before steering.')
      }
      if (!input.text.trim() && (input.files?.length ?? 0) === 0) {
        return { requestId: null, messageId: null }
      }

      const prepared: AttachmentPreparationResult = input.files?.length
        ? await this.prepareMessageInputNow(sessionId, input, { signal: options?.signal })
        : {
            content: input,
            summary: { status: 'ready', issues: [], suggestedActions: [] }
          }
      if (prepared.summary.status === 'needs_user_action') {
        return {
          requestId: null,
          messageId: null,
          attachmentPreparation: prepared.summary
        }
      }
      if (options?.signal?.aborted) throw createAbortError()
      const preparedResult: MessageStartResult = {
        requestId: null,
        messageId: null,
        attachmentPreparation: prepared.summary
      }

      if (this.pendingInputCoordinator.hasBlockingInput(sessionId)) {
        this.queueVisibleSteerInput(sessionId, prepared.content)
        return preparedResult
      }

      const instance = this.getHydratedDeepChatInstance(sessionId)
      const activeGeneration = instance?.getActiveGeneration()
      const preStreamController = instance?.getAbortController()

      if (activeGeneration) {
        // Enqueue the steer input first (it sorts ahead of queued items, and rapid successive steers
        // merge into the same pending record), then interrupt the active stream.
        this.queueVisibleSteerInput(sessionId, prepared.content)
        releaseAcceptanceLane()
        // A stream is actively producing tokens: interrupt it while preserving its partial output.
        // The abort settlement auto-drains the queue and runs the steer input as the next turn.
        await this.cancelGeneration(sessionId)
        return preparedResult
      }

      if (preStreamController) {
        this.queueVisibleSteerInput(sessionId, prepared.content)
        // The current turn is still in pre-stream setup (no tokens yet, user message not persisted).
        // Don't abort — let it finish; the steer input drains right after as the next visible turn.
        return preparedResult
      }

      if (!this.canStartPendingQueueDrain(sessionId, state.status, 'enqueue')) {
        if (instance?.isPendingQueueDraining() || state.status === 'generating') {
          this.queueVisibleSteerInput(sessionId, prepared.content)
          return preparedResult
        }
        throw new Error('Unable to start the steered input.')
      }

      const record = this.queueVisibleSteerInput(sessionId, prepared.content)
      releaseAcceptanceLane()
      const started = await this.runLifecycle.requestPendingInputDrain(sessionId, 'enqueue')
      if (started) {
        return preparedResult
      }

      const latestState = await this.getSessionState(sessionId)
      if (instance?.isPendingQueueDraining() || latestState?.status === 'generating') {
        return preparedResult
      }

      try {
        this.pendingInputCoordinator.deletePendingInput(sessionId, record.id)
        instance?.clearActiveSteerPendingInputId(record.id)
      } catch (deleteError) {
        console.error('[AgentRuntime] Failed to delete unstarted steer input:', deleteError)
      }
      throw new Error('Unable to start the steered input.')
    } finally {
      releaseAcceptanceLane()
    }
  }

  async updateQueuedInput(
    sessionId: string,
    itemId: string,
    content: string | SendMessageInput
  ): Promise<PendingSessionInputRecord> {
    await this.ensureSessionReadyForPendingInputMutation(sessionId)
    const input = typeof content === 'string' ? { text: content, files: [] } : content
    if (!input.text.trim() && (input.files?.length ?? 0) === 0) {
      throw new Error('Message cannot be empty.')
    }
    const record = this.pendingInputCoordinator.updateQueuedInput(sessionId, itemId, input)
    this.runLifecycle.schedulePendingInputDrain(sessionId, 'enqueue')
    return record
  }

  async moveQueuedInput(
    sessionId: string,
    itemId: string,
    toIndex: number
  ): Promise<PendingSessionInputRecord[]> {
    await this.ensureSessionReadyForPendingInputMutation(sessionId)
    return this.pendingInputCoordinator.moveQueuedInput(sessionId, itemId, toIndex)
  }

  /**
   * Low-level, non-interrupting promote: move a queued item into the steer lane (so it sorts ahead of
   * queued items) WITHOUT aborting the active turn. The interactive UI uses {@link steerPendingInput}
   * instead, which promotes *and* interrupts. Retained as an interface-level capability and exercised
   * by the agentSession integration tests.
   */
  async convertPendingInputToSteer(
    sessionId: string,
    itemId: string
  ): Promise<PendingSessionInputRecord> {
    await this.ensureSessionReadyForPendingInputMutation(sessionId)
    return this.pendingInputCoordinator.convertPendingInputToSteer(sessionId, itemId)
  }

  async steerPendingInput(sessionId: string, itemId: string): Promise<PendingSessionInputRecord> {
    const releaseAcceptanceLane = await this.acquireAttachmentAcceptanceLane(sessionId, 'steer')
    try {
      await this.ensureSessionReadyForPendingInputMutation(sessionId)
      if (
        this.isAwaitingToolQuestionFollowUp(sessionId) ||
        this.runLifecycle.hasPendingInteractions(sessionId)
      ) {
        throw new Error('Please resolve pending tool interactions before steering.')
      }

      const pendingInput = this.pendingInputCoordinator
        .listPendingInputs(sessionId)
        .find((item) => item.id === itemId)
      if (!pendingInput) {
        throw new Error(`Pending input not found: ${itemId}`)
      }
      if (pendingInput.mode !== 'queue' || pendingInput.state !== 'pending') {
        throw new Error('Only a pending queue input can be steered.')
      }
      if (this.pendingInputCoordinator.hasBlockingInput(sessionId)) {
        throw new Error('Resolve the blocked attachment input before steering another item.')
      }

      this.pendingInputCoordinator.claimQueuedInput(sessionId, itemId)
      let prepared: AttachmentPreparationResult
      try {
        prepared = await this.prepareMessageInputNow(sessionId, pendingInput.payload)
      } catch (error) {
        this.pendingInputCoordinator.releaseClaimedQueueInput(sessionId, itemId)
        throw error
      }
      if (prepared.summary.status === 'needs_user_action') {
        try {
          return this.pendingInputCoordinator.blockClaimedInput(
            sessionId,
            itemId,
            prepared.summary
          )
        } catch (error) {
          this.pendingInputCoordinator.releaseClaimedQueueInput(sessionId, itemId)
          throw error
        }
      }
      this.pendingInputCoordinator.releaseClaimedQueueInput(sessionId, itemId)
      this.pendingInputCoordinator.updateQueuedInput(sessionId, itemId, prepared.content)

      // Promote the queued item to steer (it now sorts ahead of any queued items), then interrupt the
      // active turn exactly like steerActiveTurn so the abort settlement runs this item as the next turn.
      const record = this.pendingInputCoordinator.convertPendingInputToSteer(sessionId, itemId)

      const instance = this.getHydratedDeepChatInstance(sessionId)
      const activeGeneration = instance?.getActiveGeneration()
      const preStreamController = instance?.getAbortController()

      if (activeGeneration) {
        releaseAcceptanceLane()
        // A stream is actively producing tokens: interrupt it while preserving its partial output.
        // The abort settlement auto-drains the queue and runs the steer item as the next turn.
        await this.cancelGeneration(sessionId)
        return record
      }

      if (preStreamController) {
        // The current turn is still in pre-stream setup (no tokens yet, user message not persisted).
        // Don't abort — let it finish; the steer input drains right after as the next visible turn.
        return record
      }

      // No turn in flight: drain immediately. If the drain cannot start, roll the promotion back to
      // the queue so the item is never stranded in the locked steer lane, and surface the failure.
      releaseAcceptanceLane()
      const started = await this.runLifecycle.requestPendingInputDrain(sessionId, 'enqueue')
      if (!started) {
        try {
          this.pendingInputCoordinator.restoreSteerInputToQueue(sessionId, itemId)
        } catch (restoreError) {
          console.error('[AgentRuntime] Failed to restore steered input to queue:', restoreError)
        }
        throw new Error('Unable to start the steered input.')
      }
      return record
    } finally {
      releaseAcceptanceLane()
    }
  }

  async deletePendingInput(sessionId: string, itemId: string): Promise<void> {
    await this.ensureSessionReadyForPendingInputMutation(sessionId)
    this.pendingInputCoordinator.deletePendingInput(sessionId, itemId)
    this.runLifecycle.schedulePendingInputDrain(sessionId, 'enqueue')
  }

  async resolveBlockedPendingInput(
    sessionId: string,
    itemId: string,
    action: 'retry' | 'send_without_image_content'
  ): Promise<PendingSessionInputRecord> {
    await this.ensureSessionReadyForPendingInputMutation(sessionId)
    const record =
      action === 'retry'
        ? this.pendingInputCoordinator.retryBlockedInput(sessionId, itemId)
        : this.pendingInputCoordinator.degradeBlockedInput(sessionId, itemId)
    this.runLifecycle.schedulePendingInputDrain(sessionId, 'enqueue')
    return record
  }

  async processMessage(
    sessionId: string,
    content: string | SendMessageInput,
    context?: TurnStartContext
  ): Promise<MessageStartResult> {
    const input = typeof content === 'string' ? { text: content, files: [] } : content
    return await this.turnCoordinator.start(sessionId, input, context)
  }

  async respondToolInteraction(
    sessionId: string,
    messageId: string,
    toolCallId: string,
    response: ToolInteractionResponse
  ): Promise<ToolInteractionResult> {
    return await this.interactionCoordinator.respond(sessionId, messageId, toolCallId, response)
  }
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    await this.sessionSettingsCoordinator.setPermissionMode(sessionId, mode)
  }

  async setSessionModel(sessionId: string, providerId: string, modelId: string): Promise<void> {
    await this.sessionSettingsCoordinator.setModel(sessionId, providerId, modelId)
  }

  async setSessionAgentContext(
    sessionId: string,
    config: SessionAgentContextUpdate
  ): Promise<void> {
    await this.sessionSettingsCoordinator.setAgentContext(sessionId, config)
  }

  async setSessionProjectDir(sessionId: string, projectDir: string | null): Promise<void> {
    this.sessionSettingsCoordinator.setProjectDir(sessionId, projectDir)
  }

  async getPermissionMode(sessionId: string): Promise<PermissionMode> {
    return this.sessionSettingsCoordinator.getPermissionMode(sessionId)
  }

  async getGenerationSettings(sessionId: string): Promise<SessionGenerationSettings | null> {
    return await this.sessionSettingsCoordinator.getGenerationSettings(sessionId)
  }

  async updateGenerationSettings(
    sessionId: string,
    settings: Partial<SessionGenerationSettings>
  ): Promise<SessionGenerationSettings> {
    return await this.sessionSettingsCoordinator.updateGenerationSettings(sessionId, settings)
  }

  async cancelGeneration(sessionId: string): Promise<void> {
    await this.runLifecycle.cancel(sessionId)
  }

  getActiveGeneration(sessionId: string): { eventId: string; runId: string } | null {
    return this.runLifecycle.getActiveGeneration(sessionId)
  }

  async cancelGenerationByEventId(sessionId: string, eventId: string): Promise<boolean> {
    if (this.runLifecycle.getActiveGeneration(sessionId)?.eventId !== eventId) {
      return false
    }
    await this.cancelGeneration(sessionId)
    return true
  }

  private dispatchTerminalHooks(
    sessionId: string,
    state: DeepChatSessionState | undefined,
    result: ProcessResult
  ): void {
    if (!state || result.status === 'paused') {
      return
    }

    this.dispatchHook('Stop', {
      sessionId,
      providerId: state.providerId,
      modelId: state.modelId,
      projectDir: this.resolveProjectDir(sessionId),
      stop: {
        reason:
          result.stopReason ??
          (result.status === 'completed'
            ? 'complete'
            : result.status === 'aborted'
              ? 'user_stop'
              : 'error'),
        userStop: result.status === 'aborted'
      }
    })
    this.dispatchHook('SessionEnd', {
      sessionId,
      providerId: state.providerId,
      modelId: state.modelId,
      projectDir: this.resolveProjectDir(sessionId),
      usage: result.usage ?? null,
      error:
        result.errorMessage || result.terminalError
          ? {
              message: result.errorMessage ?? result.terminalError
            }
          : null
    })
  }

  private dispatchHook(
    event:
      | 'UserPromptSubmit'
      | 'SessionStart'
      | 'PreToolUse'
      | 'PostToolUse'
      | 'PostToolUseFailure'
      | 'PermissionRequest'
      | 'Stop'
      | 'SessionEnd',
    context: {
      sessionId: string
      messageId?: string
      promptPreview?: string
      providerId?: string
      modelId?: string
      projectDir?: string | null
      tool?: {
        callId?: string
        name?: string
        params?: string
        response?: string
        error?: string
      }
      permission?: Record<string, unknown> | null
      stop?: {
        reason?: string
        userStop?: boolean
      } | null
      usage?: Record<string, number> | null
      error?: {
        message?: string
        stack?: string
      } | null
    }
  ): void {
    try {
      this.hookObserver.notify({
        event,
        context: {
          ...context,
          agentId: this.getSessionAgentId(context.sessionId) ?? 'deepchat'
        }
      })
    } catch (error) {
      console.warn(`[DeepChatAgent] Failed to dispatch ${event} hook:`, error)
    }
  }

  private getSessionAgentId(sessionId: string): string | undefined {
    const instance = this.deepChatRuntime.getHydrated(toAppSessionId(sessionId))
    const cached = instance?.getAgentId()?.trim()
    if (cached) {
      return cached
    }

    const persisted = this.sqlitePresenter.newSessionsTable?.get(sessionId)?.agent_id?.trim()
    if (persisted) {
      instance?.setAgentId(persisted)
      return persisted
    }

    return undefined
  }

  private isAcpBackedSubagentSession(sessionId: string, providerId?: string): boolean {
    const sessionRow = this.sqlitePresenter.newSessionsTable?.get(sessionId)
    if (!sessionRow || sessionRow.session_kind !== 'subagent') {
      return false
    }

    const resolvedProviderId =
      providerId?.trim() || this.getDeepChatRuntimeState(sessionId)?.providerId?.trim() || ''
    return resolvedProviderId === 'acp'
  }

  async getSessionCompactionState(sessionId: string): Promise<SessionCompactionState> {
    return await this.getSessionCompactionStateForInstance(sessionId)
  }

  private async getSessionCompactionStateForInstance(
    sessionId: string,
    expectedInstance?: DeepChatAgentInstance
  ): Promise<SessionCompactionState> {
    const hydratedInstance = expectedInstance ?? this.getHydratedDeepChatInstance(sessionId)
    const runtimeState = hydratedInstance?.getRuntimeState()
    const session = this.sessionStore.get(sessionId)
    if (!runtimeState && !session) {
      throw new Error(`Session ${sessionId} not found`)
    }
    const instance = hydratedInstance ?? this.getDeepChatInstance(sessionId)
    this.throwIfStaleDeepChatInstance(sessionId, instance)

    const persistedState = this.compactionRuntimeCoordinator.fromSummary(
      this.sessionStore.getSummaryState(sessionId)
    )
    const currentCompactionState = instance.getCompactionState()
    if (currentCompactionState?.status === 'compacting') {
      return currentCompactionState
    }

    if (
      currentCompactionState &&
      this.compactionRuntimeCoordinator.isSame(currentCompactionState, persistedState)
    ) {
      return currentCompactionState
    }

    instance.setCompactionState(persistedState)
    return { ...persistedState }
  }

  async compactSession(
    sessionId: string
  ): Promise<{ compacted: boolean; state: SessionCompactionState }> {
    const instance = this.getDeepChatInstance(sessionId)
    const scope = this.runLifecycle.scopeFor(sessionId, instance)
    const state = instance.getRuntimeState() ?? (await this.getSessionListState(sessionId))
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }
    this.throwIfStaleDeepChatInstance(sessionId, instance)
    const modelConfig = this.providerSettings.getModelConfig(state.modelId, state.providerId)
    if (shouldBypassDeepChatContextBudget(state.providerId, modelConfig, state.modelId)) {
      throw new Error('Manual compaction is only available for DeepChat agent sessions.')
    }
    if (state.status !== 'idle') {
      throw new Error('Manual compaction is only available when the session is idle.')
    }
    if (this.runLifecycle.hasPendingInteractions(sessionId)) {
      throw new Error('Pending tool interactions must be resolved before compacting.')
    }

    this.runLifecycle.transitionStatus(scope, 'generating')
    const compactionAbortController = this.runLifecycle.ensureOperationController(scope)
    const compactionAbortSignal = compactionAbortController.signal
    try {
      throwIfAbortRequested(compactionAbortSignal)
      const generationSettings = await awaitWithAbort(
        this.getEffectiveSessionGenerationSettings(sessionId, instance),
        compactionAbortSignal
      )
      const interleavedReasoning = resolveInterleavedReasoningConfig(
        this.providerSettings,
        state.providerId,
        state.modelId,
        generationSettings
      )
      const contextBudgetLength = resolveDeepChatContextBudgetLength(
        state.providerId,
        generationSettings.contextLength,
        modelConfig,
        state.modelId
      )
      const maxTokens = capAgentRequestMaxTokens(generationSettings.maxTokens, contextBudgetLength)
      const activeSkillNames = await awaitWithAbort(
        this.toolResolver.resolveActiveSkillNamesForToolProfile(sessionId),
        compactionAbortSignal
      )
      this.throwIfStaleDeepChatInstance(sessionId, instance)
      const projectDir = this.resolveProjectDir(sessionId, undefined, instance)
      const tools = await awaitWithAbort(
        this.toolResolver.loadToolDefinitionsForSession(
          sessionId,
          projectDir,
          activeSkillNames,
          instance
        ),
        compactionAbortSignal
      )
      const toolReserveTokens = estimateToolReserveTokens(tools)
      const baseSystemPrompt = await awaitWithAbort(
        this.createBasePromptAssembler(instance).assemble({
          sessionId: toAppSessionId(sessionId),
          configuredPrompt: generationSettings.systemPrompt,
          toolDefinitions: tools,
          activeSkillNames
        }),
        compactionAbortSignal
      )
      throwIfAbortRequested(compactionAbortSignal)
      const tapeReady = this.tapeService.ensureSessionTapeReady(sessionId, this.messageStore)
      const { supportsVision, supportsAudioInput } = resolveProviderInputCapabilities(
        this.providerSettings,
        state.providerId,
        state.modelId
      )

      const intent = await this.compactionService.prepareForManualCompaction({
        sessionId,
        providerId: state.providerId,
        modelId: state.modelId,
        systemPrompt: baseSystemPrompt,
        contextLength: generationSettings.contextLength,
        reserveTokens: maxTokens,
        extraReserveTokens: toolReserveTokens,
        supportsVision,
        supportsAudioInput,
        preserveInterleavedReasoning: interleavedReasoning.preserveReasoningContent,
        preserveEmptyInterleavedReasoning:
          interleavedReasoning.preserveEmptyReasoningContent === true,
        historyRecords: tapeReady.historyRecords,
        signal: compactionAbortSignal
      })
      throwIfAbortRequested(compactionAbortSignal)
      this.throwIfStaleDeepChatInstance(sessionId, instance)

      if (!intent) {
        return {
          compacted: false,
          state: await this.getSessionCompactionStateForInstance(sessionId, instance)
        }
      }

      const summaryState = await this.applyCompactionIntent(
        sessionId,
        intent,
        { signal: compactionAbortSignal },
        instance
      )
      throwIfAbortRequested(compactionAbortSignal)
      this.throwIfStaleDeepChatInstance(sessionId, instance)
      const compacted = summaryState.summaryUpdatedAt !== intent.previousState.summaryUpdatedAt
      return {
        compacted,
        state: await this.getSessionCompactionStateForInstance(sessionId, instance)
      }
    } finally {
      const stillOwnsLifecycle = this.runLifecycle.canSettleOperation(
        scope,
        compactionAbortController
      )
      this.runLifecycle.clearOperationController(scope, compactionAbortController)
      if (stillOwnsLifecycle) {
        this.runLifecycle.transitionStatus(scope, 'idle')
      }
    }
  }

  async prepareClearMessages(sessionId: string): Promise<void> {
    const instance = this.getDeepChatInstance(sessionId)
    const state = await this.getSessionState(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }
    this.throwIfStaleDeepChatInstance(sessionId, instance)

    await this.cancelGeneration(sessionId)
    this.throwIfStaleDeepChatInstance(sessionId, instance)
    this.runLifecycle.clearFirstTurnReady(sessionId)
    this.memoryCoordinator.resetExtractionCursor(sessionId)
    this.memoryCoordinator.clearProjectionRetry(sessionId)
  }

  finishClearMessages(sessionId: string): void {
    const instance = this.getDeepChatInstance(sessionId)
    instance.replacePendingInteractions([])
    this.compactionRuntimeCoordinator.reset(sessionId, instance)
    this.runLifecycle.transitionStatus(this.runLifecycle.scopeFor(sessionId, instance), 'idle')
  }

  async prepareRetry(sessionId: string): Promise<{ projectDir: string | null }> {
    const instance = this.getDeepChatInstance(sessionId)
    const state = await this.getSessionState(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }
    this.throwIfStaleDeepChatInstance(sessionId, instance)
    if (state.status === 'generating') {
      throw new Error('Cannot retry while session is generating.')
    }
    if (this.runLifecycle.hasPendingInteractions(sessionId)) {
      throw new Error('Please resolve pending tool interactions before retrying.')
    }
    this.assertNoActivePendingInputs(sessionId)
    this.throwIfStaleDeepChatInstance(sessionId, instance)
    return { projectDir: this.resolveProjectDir(sessionId, undefined, instance) }
  }

  async cancelForTranscriptMutation(sessionId: string): Promise<void> {
    const instance = this.getDeepChatInstance(sessionId)
    await this.cancelGeneration(sessionId)
    this.throwIfStaleDeepChatInstance(sessionId, instance)
  }

  invalidateTranscriptFrom(sessionId: string, orderSeq: number): void {
    const instance = this.getDeepChatInstance(sessionId)
    this.compactionRuntimeCoordinator.invalidateIfNeeded(sessionId, orderSeq, instance)
    this.memoryCoordinator.invalidateFromOrderSeq(sessionId, orderSeq)
  }

  finishTranscriptTruncate(sessionId: string): void {
    this.runLifecycle.refreshPendingInteractions(sessionId)
    this.runLifecycle.transitionCurrentStatus(sessionId, 'idle')
  }

  resetForkTarget(targetSessionId: string): void {
    const targetInstance = this.getDeepChatInstance(targetSessionId)
    this.compactionRuntimeCoordinator.reset(targetSessionId, targetInstance)
  }

  private async runStreamForMessage(
    args: DeepChatLoopRunInput
  ): Promise<{ runId: string; result: ProcessResult }> {
    return await this.loopRunner.run(args)
  }

  rollbackClaimedPendingInputTurn(
    sessionId: string,
    pendingQueueItemId: string,
    pendingInputSource: ProcessPendingInputSource,
    userMessageId: string | null,
    expectedInstance?: DeepChatAgentInstance
  ): void {
    this.turnCoordinator.rollbackClaimedPendingInputTurn(
      sessionId,
      pendingQueueItemId,
      pendingInputSource,
      userMessageId,
      expectedInstance
    )
  }

  private async executeDeferredToolCall(
    sessionId: string,
    messageId: string,
    toolCall: NonNullable<AssistantMessageBlock['tool_call']>,
    onToolCallStarted?: () => void
  ): Promise<DeferredToolExecutionResult> {
    return await this.deferredToolExecutor.execute(
      sessionId,
      messageId,
      toolCall,
      onToolCallStarted
    )
  }

  private async drainPendingQueueIfPossible(
    sessionId: string,
    reason: 'enqueue' | 'completed'
  ): Promise<boolean> {
    const state = await this.getSessionState(sessionId)
    if (!state || !this.canStartPendingQueueDrain(sessionId, state.status, reason)) {
      return false
    }
    const instance = this.getHydratedDeepChatInstance(sessionId)
    if (!instance) {
      return false
    }
    if (
      this.pendingInputCoordinator.hasBlockingInput(sessionId) ||
      this.pendingInputCoordinator.hasClaimedInput(sessionId)
    ) {
      return false
    }

    const nextSteerInput = this.pendingInputCoordinator.getNextSteerInput(sessionId)
    const nextQueuedInput = nextSteerInput
      ? null
      : this.pendingInputCoordinator.getNextQueuedInput(sessionId)
    const nextPendingInput = nextSteerInput ?? nextQueuedInput
    if (!nextPendingInput) {
      return false
    }
    let projectDir: string | null
    try {
      projectDir = this.resolveProjectDir(sessionId)
    } catch (error) {
      logger.error(
        `[DeepChatAgent] drainPendingQueueIfPossible error session=${sessionId} reason=${reason} stage=resolve-project-dir`,
        redactRuntimeErrorForLog(error)
      )
      return false
    }

    const pendingInputSource: ProcessPendingInputSource = nextSteerInput ? 'steer' : 'queue'
    let claimedInput: PendingSessionInputRecord

    instance.markPendingQueueDrainStarted()
    try {
      claimedInput =
        pendingInputSource === 'steer'
          ? this.pendingInputCoordinator.claimSteerInput(sessionId, nextPendingInput.id)
          : this.pendingInputCoordinator.claimQueuedInput(sessionId, nextPendingInput.id)
    } catch (error) {
      // Claiming also publishes an update. If publication throws after the database mutation, the
      // row is already claimed; release is idempotent for a row that never left the pending state.
      this.tryReleaseClaimedPendingInput(sessionId, nextPendingInput.id, pendingInputSource)
      instance.markPendingQueueDrainFinished()
      logger.error(
        `[DeepChatAgent] drainPendingQueueIfPossible error session=${sessionId} reason=${reason} stage=claim-input`,
        redactRuntimeErrorForLog(error)
      )
      return false
    }

    try {
      if (pendingInputSource === 'steer') {
        instance.clearActiveSteerPendingInputId()
      }
    } catch (error) {
      this.tryReleaseClaimedPendingInput(sessionId, claimedInput.id, pendingInputSource)
      instance.markPendingQueueDrainFinished()
      logger.error(
        `[DeepChatAgent] drainPendingQueueIfPossible error session=${sessionId} reason=${reason} stage=clear-steer`,
        redactRuntimeErrorForLog(error)
      )
      return false
    }

    void this.processMessage(sessionId, claimedInput.payload, {
      projectDir,
      pendingQueueItemId: claimedInput.id,
      pendingQueueItemSource: pendingInputSource
    })
      .catch((error) => {
        logger.error(
          `[DeepChatAgent] drainPendingQueueIfPossible error session=${sessionId} reason=${reason} stage=process-message`,
          redactRuntimeErrorForLog(error)
        )
      })
      .finally(async () => {
        instance.markPendingQueueDrainFinished()
        try {
          const releasedInputIsWaitingForRetry = this.pendingInputCoordinator
            .listPendingInputs(sessionId)
            .some((item) => item.id === claimedInput.id && item.state === 'pending')
          if (
            !releasedInputIsWaitingForRetry &&
            this.pendingInputCoordinator.hasPendingTurnInput(sessionId) &&
            (await this.getSessionState(sessionId))?.status === 'idle' &&
            !this.runLifecycle.hasPendingInteractions(sessionId)
          ) {
            this.runLifecycle.schedulePendingInputDrain(sessionId, 'completed')
          }
        } catch (error) {
          logger.error(
            `[DeepChatAgent] drainPendingQueueIfPossible error session=${sessionId} reason=${reason} stage=cleanup`,
            redactRuntimeErrorForLog(error)
          )
        }
      })
      .catch((error) => {
        logger.error(
          `[DeepChatAgent] drainPendingQueueIfPossible error session=${sessionId} reason=${reason} stage=finalization`,
          redactRuntimeErrorForLog(error)
        )
      })

    return true
  }

  private tryReleaseClaimedPendingInput(
    sessionId: string,
    pendingInputId: string,
    pendingInputSource: ProcessPendingInputSource
  ): void {
    try {
      if (pendingInputSource === 'steer') {
        this.pendingInputCoordinator.releaseClaimedInput(sessionId, pendingInputId)
      } else {
        this.pendingInputCoordinator.releaseClaimedQueueInput(sessionId, pendingInputId)
      }
    } catch (error) {
      console.warn('[DeepChatAgent] failed to release claimed pending input:', error)
    }
  }

  private shouldStartQueuedInputImmediately(
    sessionId: string,
    status: DeepChatSessionState['status']
  ): boolean {
    if (!this.canStartPendingQueueDrain(sessionId, status, 'enqueue')) {
      return false
    }
    return (
      !this.pendingInputCoordinator.hasPendingTurnInput(sessionId) &&
      !this.pendingInputCoordinator.hasBlockingInput(sessionId) &&
      !this.pendingInputCoordinator.hasClaimedInput(sessionId)
    )
  }

  private canStartPendingQueueDrain(
    sessionId: string,
    status: DeepChatSessionState['status'],
    reason: 'enqueue' | 'completed'
  ): boolean {
    if (!this.canDrainPendingQueueFromStatus(status, reason)) {
      return false
    }
    if (this.isAwaitingToolQuestionFollowUp(sessionId)) {
      return false
    }
    if (this.runLifecycle.hasPendingInteractions(sessionId)) {
      return false
    }
    if (this.getHydratedDeepChatInstance(sessionId)?.isPendingQueueDraining()) {
      return false
    }
    return true
  }

  private canDrainPendingQueueFromStatus(
    status: DeepChatSessionState['status'],
    reason: 'enqueue' | 'completed'
  ): boolean {
    if (status === 'idle') {
      return true
    }

    return reason === 'enqueue' && status === 'error'
  }

  private async resumeAssistantMessage(
    sessionId: string,
    messageId: string,
    initialBlocks: AssistantMessageBlock[],
    budgetToolCall?: ResumeBudgetToolCall | null,
    initialAccounting?: MessageMetadata
  ): Promise<boolean> {
    return await this.turnCoordinator.resume(
      sessionId,
      messageId,
      initialBlocks,
      budgetToolCall,
      initialAccounting
    )
  }
  private async buildSystemPromptWithSkills(
    sessionId: string,
    basePrompt: string,
    toolDefinitions: MCPToolDefinition[],
    activeSkillNamesOverride?: string[],
    resourceInstance = this.getDeepChatInstance(sessionId)
  ): Promise<string> {
    return await buildSystemPromptWithSkills(
      {
        providerSettings: this.providerSettings,
        skillSettings: this.skillSettings,
        skillService: this.skillService,
        providerCatalogPort: this.providerCatalogPort,
        toolService: this.toolService,
        assertCurrent: (id, instance) => this.throwIfStaleDeepChatInstance(id, instance),
        isAcpBackedSubagentSession: (id, providerId) =>
          this.isAcpBackedSubagentSession(id, providerId),
        resolveProjectDir: (id, projectDir, instance) =>
          this.resolveProjectDir(id, projectDir, instance),
        logSlowStep: logSlowPreStreamStep
      },
      {
        sessionId,
        basePrompt,
        toolDefinitions,
        activeSkillNamesOverride,
        resourceInstance
      }
    )
  }

  private invalidateToolProfileCache(sessionId: string): void {
    this.getHydratedDeepChatInstance(sessionId)?.invalidateToolProfileCache()
  }

  private handleToolRegistryChanged(): void {
    this.deepChatRuntime.markToolRegistryChanged()
  }

  private async getEffectiveSessionGenerationSettings(
    sessionId: string,
    expectedInstance = this.getDeepChatInstance(sessionId)
  ): Promise<SessionGenerationSettings> {
    this.throwIfStaleDeepChatInstance(sessionId, expectedInstance)
    const cached = expectedInstance.getGenerationSettings()
    if (cached) {
      return { ...cached }
    }

    const state = expectedInstance.getRuntimeState()
    const dbSession = this.sessionStore.get(sessionId) as PersistedSessionGenerationRow | undefined
    const providerId = state?.providerId ?? dbSession?.provider_id
    const modelId = state?.modelId ?? dbSession?.model_id

    if (!providerId || !modelId) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const persistedPatch = dbSession
      ? mapPersistedGenerationPatch(this.providerSettings, dbSession)
      : {}
    const sanitized = await sanitizeGenerationSettings(
      this.providerSettings,
      this.promptSettings,
      providerId,
      modelId,
      persistedPatch
    )
    this.throwIfStaleDeepChatInstance(sessionId, expectedInstance)
    expectedInstance.setGenerationSettings(sanitized)
    return { ...sanitized }
  }

  private async ensureSessionReadyForPendingInputMutation(sessionId: string): Promise<void> {
    const state = await this.getSessionState(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }
  }

  assertNoActivePendingInputs(sessionId: string): void {
    if (!this.pendingInputCoordinator.hasActiveInputs(sessionId)) {
      return
    }
    throw new Error('Please clear the waiting lane before mutating chat history.')
  }

  private queueVisibleSteerInput(
    sessionId: string,
    input: SendMessageInput
  ): PendingSessionInputRecord {
    const instance = this.getDeepChatInstance(sessionId)
    const mergeItemId = instance.getActiveSteerPendingInputId() ?? null
    try {
      const record = this.pendingInputCoordinator.queueSteerInput(sessionId, input, {
        mergeItemId
      })
      instance.setActiveSteerPendingInputId(record.id)
      return record
    } catch (error) {
      if (!mergeItemId) {
        throw error
      }
      instance.clearActiveSteerPendingInputId()
      const record = this.pendingInputCoordinator.queueSteerInput(sessionId, input)
      instance.setActiveSteerPendingInputId(record.id)
      return record
    }
  }

  private updateSubagentToolCallProgress(
    sessionId: string,
    messageId: string,
    toolCallId: string,
    responseMarkdown: string,
    progressJson?: string,
    finalJson?: string
  ): void {
    try {
      const message = this.messageStore.getMessage(messageId)
      if (!message || message.role !== 'assistant') {
        return
      }

      const blocks = JSON.parse(message.content) as AssistantMessageBlock[]
      const toolBlock = blocks.find(
        (block) => block.type === 'tool_call' && block.tool_call?.id === toolCallId
      )
      if (!toolBlock?.tool_call) {
        return
      }

      toolBlock.tool_call.response = responseMarkdown
      toolBlock.status = finalJson ? 'success' : 'loading'
      toolBlock.extra = {
        ...toolBlock.extra,
        ...(typeof progressJson === 'string' ? { subagentProgress: progressJson } : {}),
        ...(finalJson ? { subagentFinal: finalJson } : {})
      }
      this.messageStore.updateAssistantContent(messageId, blocks)
      this.emitMessageRefresh(sessionId, messageId)
    } catch (error) {
      console.warn('[DeepChatAgent] Failed to persist subagent tool progress:', error)
    }
  }

  private async normalizeToolResultContent(params: {
    sessionId: string
    toolCallId: string
    toolName: string
    toolArgs: string
    content: MCPToolResponse['content']
    isError: boolean
    abortSignal?: AbortSignal
  }): Promise<MCPToolResponse['content']> {
    return await normalizeToolResultContent(
      {
        providerSettings: this.providerSettings,
        agentSettings: this.agentSettings,
        providerRuntime: this.providerRuntime,
        getAbortSignal: (sessionId) => this.runLifecycle.getAbortSignal(sessionId),
        getSessionModel: (sessionId) => {
          const state = this.getDeepChatRuntimeState(sessionId)
          const persisted = this.sessionStore.get(sessionId)
          return {
            providerId: state?.providerId ?? persisted?.provider_id,
            modelId: state?.modelId ?? persisted?.model_id,
            agentId: this.getSessionAgentId(sessionId)
          }
        }
      },
      params
    )
  }

  private isAwaitingToolQuestionFollowUp(sessionId: string): boolean {
    const messages = this.messageStore.getMessages(sessionId)
    let latestUserOrderSeq = 0

    for (const message of messages) {
      if (message.role === 'user') {
        latestUserOrderSeq = Math.max(latestUserOrderSeq, message.orderSeq)
      }
    }

    return messages.some((message) => {
      if (message.role !== 'assistant' || message.orderSeq <= latestUserOrderSeq) {
        return false
      }

      return parseAssistantBlocks(message.content).some(
        (block) =>
          block.type === 'action' &&
          block.action_type === 'question_request' &&
          block.status === 'success' &&
          block.extra?.needsUserAction === false &&
          block.extra?.questionResolution === 'replied' &&
          block.extra?.questionFollowUpPending === true
      )
    })
  }

  private async applyCompactionIntent(
    sessionId: string,
    intent: CompactionIntent | null,
    options?: {
      compactionMessageId?: string
      compactionMessageOrderSeq?: number
      shiftMessagesFromCompactionOrderSeq?: boolean
      startedExternally?: boolean
      signal?: AbortSignal
    },
    expectedInstance = this.getDeepChatInstance(sessionId)
  ): Promise<SessionSummaryState> {
    return await this.compactionRuntimeCoordinator.apply(
      sessionId,
      intent,
      options,
      expectedInstance
    )
  }

  private emitMessageRefresh(sessionId: string, messageId: string): void {
    this.publishEvent('chat.stream.completed', {
      requestId: this.runLifecycle.resolveStreamRequestId(sessionId, messageId),
      sessionId,
      messageId,
      completedAt: Date.now()
    })

    const message = this.messageStore.getMessage(messageId)
    if (!message || message.role !== 'assistant') {
      return
    }

    try {
      const blocks = JSON.parse(message.content) as AssistantMessageBlock[]
      this.publishSessionUpdate({
        sessionId,
        kind: 'blocks',
        updatedAt: Date.now(),
        messageId,
        previewMarkdown: buildAssistantPreviewMarkdown(blocks),
        responseMarkdown: buildAssistantResponseMarkdown(blocks),
        deliverySegments: buildAssistantDeliverySegments(messageId, blocks),
        waitingInteraction: extractWaitingInteraction(blocks, messageId)
      })
    } catch (error) {
      console.warn('[DeepChatAgent] Failed to emit internal message refresh:', error)
    }
  }

  private normalizeProjectDir(projectDir?: string | null): string | null {
    const normalized = projectDir?.trim()
    return normalized ? normalized : null
  }

  private resolvePersistedSessionProjectDir(sessionId: string): string | null {
    try {
      const session = this.sqlitePresenter.newSessionsTable?.get(sessionId)
      return this.normalizeProjectDir(session?.project_dir ?? null)
    } catch (error) {
      console.warn('[DeepChatAgent] Failed to resolve persisted project directory:', {
        sessionId,
        error
      })
      return null
    }
  }

  private resolveProjectDir(
    sessionId: string,
    incoming?: string | null,
    expectedInstance = this.getDeepChatInstance(sessionId)
  ): string | null {
    this.throwIfStaleDeepChatInstance(sessionId, expectedInstance)
    const instance = expectedInstance
    if (incoming !== undefined) {
      const normalized = this.normalizeProjectDir(incoming)
      const previous = instance.hasProjectDir()
        ? instance.getProjectDir()
        : this.resolvePersistedSessionProjectDir(sessionId)
      instance.setProjectDir(normalized)
      if (previous !== normalized) {
        instance.invalidateToolProfileCache()
      }
      return normalized
    }
    if (instance.hasProjectDir()) {
      return instance.getProjectDir()
    }

    const persisted = this.resolvePersistedSessionProjectDir(sessionId)
    instance.setProjectDir(persisted)
    return persisted
  }
}
