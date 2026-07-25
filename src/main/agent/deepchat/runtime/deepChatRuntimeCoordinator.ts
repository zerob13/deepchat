import type { ProviderModelResolutionPort } from '@/provider/settings'
import logger from '@shared/logger'
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
import {
  sanitizeGenerationSettings,
  type PersistedSessionGenerationRow
} from './generationSettings'
import { CompactionService } from './compactionService'
import { buildContextCheckpoint } from './contextContributions'
import { reviewAutoApproveToolPermission } from './toolPermissionReviewer'
import type { SessionData } from '@/session/data'
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
  type TurnStartContext
} from './turnCoordinator'
import type { HookObserver } from '@/hook/observer'
import type {
  AcpAsLlmProviderPermissionPort,
  ProviderCatalogPort
} from '@/provider/ports'
import type { SessionPermissionPort, SessionUiPort } from '@/session/contracts'
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
import { SessionStatusPublisher } from './sessionStatusPublisher'
import { RunLifecycleCoordinator } from './runLifecycleCoordinator'
import type { AttachmentCapabilityRouter } from '@/ocr/attachmentCapabilityRouter'
import { PendingInputPump } from './pendingInputPump'
import { PendingInputAdmissionCoordinator } from './pendingInputAdmissionCoordinator'
import { RuntimeHookSink } from './runtimeHookSink'

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
  private readonly runtimeHookSink: RuntimeHookSink
  private readonly providerCatalogPort: Pick<
    ProviderCatalogPort,
    'getProviderModels' | 'getCustomModels'
  >
  private readonly sessionPermissionPort: SessionPermissionPort
  private readonly acpAsLlmProviderPermission: AcpAsLlmProviderPermissionPort
  private readonly sessionStatusPublisher: SessionStatusPublisher
  private readonly runLifecycle: RunLifecycleCoordinator
  private readonly pendingInputPump: PendingInputPump
  private readonly pendingInputAdmission: PendingInputAdmissionCoordinator
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
      getHydratedInstance: (sessionId) => this.getHydratedDeepChatInstance(sessionId),
      assertCurrent: (sessionId, instance) =>
        this.throwIfStaleDeepChatInstance(sessionId, instance),
      beginSessionAgentReassignment: async (sessionId) =>
        await this.memoryCoordinator.beginSessionAgentReassignment(sessionId),
      finishSessionAgentReassignment: (sessionId) =>
        this.memoryCoordinator.finishSessionAgentReassignment(sessionId),
      readPersistedProjectDir: (sessionId) =>
        this.sqlitePresenter.newSessionsTable?.get(sessionId)?.project_dir
    })
    this.runtimeHookSink = new RuntimeHookSink({
      observer: hookObserver,
      getSessionAgentId: (sessionId) => this.getSessionAgentId(sessionId),
      resolveProjectDir: (sessionId) =>
        this.sessionSettingsCoordinator.resolveProjectDir(sessionId)
    })
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
          this.runtimeHookSink.observeTerminal(sessionId, state, result)
      },
      // Run settlement wakes the pump, while the pump starts turns through this lifecycle owner.
      pendingInputWakeup: {
        drain: async (sessionId, reason) => await this.pendingInputPump.drain(sessionId, reason)
      }
    })
    this.providerPermissionCoordinator = new ProviderPermissionCoordinator({
      publishEvent: this.publishEvent,
      messageStore: this.messageStore,
      runLifecycle: this.runLifecycle,
      permissionPort: this.acpAsLlmProviderPermission,
      emitMessageRefresh: (sessionId, messageId) => this.emitMessageRefresh(sessionId, messageId)
    })
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
      providerSettings: this.providerSettings,
      toolResolver: this.toolResolver,
      runLifecycle: this.runLifecycle,
      sessionSettings: this.sessionSettingsCoordinator,
      tapeReconciliation: this.tapeService,
      getInstance: (sessionId) => this.getDeepChatInstance(sessionId),
      getHydratedInstance: (sessionId) => this.getHydratedDeepChatInstance(sessionId),
      getSessionListState: async (sessionId) => await this.getSessionListState(sessionId),
      assertCurrent: (sessionId, instance) =>
        this.throwIfStaleDeepChatInstance(sessionId, instance),
      createBasePromptAssembler: (instance) => this.createBasePromptAssembler(instance),
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
      resolveProjectDir: (sessionId) => this.sessionSettingsCoordinator.resolveProjectDir(sessionId),
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
        await this.sessionSettingsCoordinator.getEffectiveGenerationSettings(sessionId, instance),
      createBasePromptAssembler: (instance) => this.createBasePromptAssembler(instance),
      getSessionAgentId: (sessionId) => this.getSessionAgentId(sessionId),
      sessionPermissionPort: this.sessionPermissionPort,
      reviewToolPermission: async (request, context) =>
        await this.reviewToolPermissionForAutoApprove(request, context),
      hookSink: this.runtimeHookSink,
      applyCompactionIntent: async (sessionId, intent, options, instance) =>
        await this.compactionRuntimeCoordinator.apply(sessionId, intent, options, instance)
    })
    this.turnCoordinator = new TurnCoordinator({
      publishEvent: this.publishEvent,
      providerSettings: this.providerSettings,
      traceSettings: this.traceSettings,
      toolService: this.toolService,
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      tapeReconciliation: this.tapeService,
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
        this.sessionSettingsCoordinator.resolveProjectDir(sessionId, projectDir, instance),
      getEffectiveSessionGenerationSettings: async (sessionId, instance) =>
        await this.sessionSettingsCoordinator.getEffectiveGenerationSettings(sessionId, instance),
      createBasePromptAssembler: (instance) => this.createBasePromptAssembler(instance),
      runStreamForMessage: async (args) => await this.runStreamForMessage(args),
      emitMessageRefresh: (sessionId, messageId) => this.emitMessageRefresh(sessionId, messageId),
      hookSink: this.runtimeHookSink
    })
    this.pendingInputPump = new PendingInputPump({
      pendingInputs: this.pendingInputCoordinator,
      transcript: this.messageStore,
      runLifecycle: this.runLifecycle,
      turnStarter: {
        start: async (sessionId, content, context) =>
          await this.turnCoordinator.start(sessionId, content, context)
      },
      getSessionState: async (sessionId) => await this.getSessionState(sessionId),
      resolveProjectDir: (sessionId) => this.sessionSettingsCoordinator.resolveProjectDir(sessionId)
    })
    this.pendingInputAdmission = new PendingInputAdmissionCoordinator({
      providerSettings: this.providerSettings,
      pendingInputs: this.pendingInputCoordinator,
      pump: this.pendingInputPump,
      runLifecycle: this.runLifecycle,
      attachmentRouter: this.attachmentRouter,
      getSessionState: async (sessionId) => await this.getSessionState(sessionId),
      getHydratedInstance: (sessionId) => this.getHydratedDeepChatInstance(sessionId),
      resolveProjectDir: (sessionId, projectDir) =>
        this.sessionSettingsCoordinator.resolveProjectDir(sessionId, projectDir)
    })
    this.interactionCoordinator = new InteractionCoordinator({
      publishEvent: this.publishEvent,
      messageStore: this.messageStore,
      providerPermissionCoordinator: this.providerPermissionCoordinator,
      skillService: this.skillService,
      runLifecycle: this.runLifecycle,
      getDeepChatInstance: (sessionId) => this.getDeepChatInstance(sessionId),
      getRuntimeState: (sessionId) => this.getDeepChatRuntimeState(sessionId),
      resolveProjectDir: (sessionId) => this.sessionSettingsCoordinator.resolveProjectDir(sessionId),
      sessionPermissionPort: this.sessionPermissionPort,
      executeDeferredToolCall: async (...args) => await this.executeDeferredToolCall(...args),
      emitMessageRefresh: (sessionId, messageId) => this.emitMessageRefresh(sessionId, messageId),
      hookSink: this.runtimeHookSink,
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
          await this.sessionSettingsCoordinator.getEffectiveGenerationSettings(sessionId, instance),
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
        dispatchHook: (event, context) => this.runtimeHookSink.dispatch(event, context)
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
          return await this.pendingInputAdmission.sendQueuedMessage(
            sessionId,
            input.content,
            input.queue,
            input.context
          )
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
    const projectDir = this.sessionSettingsCoordinator.normalizeProjectDir(config.projectDir)
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
    instance.invalidateToolProfileCache()
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
        await this.sessionSettingsCoordinator.getEffectiveGenerationSettings(sessionId)
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
      await this.sessionSettingsCoordinator.getEffectiveGenerationSettings(sessionId)
    }
    return {
      ...rebuilt,
      ...(hasPendingInteractions ? { status: 'generating' as const } : {})
    }
  }

  async listPendingInputs(sessionId: string): Promise<PendingSessionInputRecord[]> {
    return this.pendingInputAdmission.list(sessionId)
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
    return await this.pendingInputAdmission.queue(sessionId, content, options)
  }

  async steerActiveTurn(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    return await this.pendingInputAdmission.steerActiveTurn(sessionId, content, options)
  }

  async updateQueuedInput(
    sessionId: string,
    itemId: string,
    content: string | SendMessageInput
  ): Promise<PendingSessionInputRecord> {
    return await this.pendingInputAdmission.updateQueuedInput(sessionId, itemId, content)
  }

  async moveQueuedInput(
    sessionId: string,
    itemId: string,
    toIndex: number
  ): Promise<PendingSessionInputRecord[]> {
    return await this.pendingInputAdmission.moveQueuedInput(sessionId, itemId, toIndex)
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
    return await this.pendingInputAdmission.convertPendingInputToSteer(sessionId, itemId)
  }

  async steerPendingInput(sessionId: string, itemId: string): Promise<PendingSessionInputRecord> {
    return await this.pendingInputAdmission.steerPendingInput(sessionId, itemId)
  }

  async deletePendingInput(sessionId: string, itemId: string): Promise<void> {
    await this.pendingInputAdmission.deletePendingInput(sessionId, itemId)
  }

  async resolveBlockedPendingInput(
    sessionId: string,
    itemId: string,
    action: 'retry' | 'send_without_image_content'
  ): Promise<PendingSessionInputRecord> {
    return await this.pendingInputAdmission.resolveBlockedPendingInput(
      sessionId,
      itemId,
      action
    )
  }

  async processMessage(
    sessionId: string,
    content: string | SendMessageInput,
    context?: TurnStartContext
  ): Promise<MessageStartResult> {
    const input = typeof content === 'string' ? { text: content, files: [] } : content
    const completion = await this.turnCoordinator.start(sessionId, input, context)
    return completion.messageStart
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
    return await this.compactionRuntimeCoordinator.getState(sessionId)
  }

  async compactSession(
    sessionId: string
  ): Promise<{ compacted: boolean; state: SessionCompactionState }> {
    return await this.compactionRuntimeCoordinator.compact(sessionId)
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
    return {
      projectDir: this.sessionSettingsCoordinator.resolveProjectDir(
        sessionId,
        undefined,
        instance
      )
    }
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
          this.sessionSettingsCoordinator.resolveProjectDir(id, projectDir, instance),
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

  private handleToolRegistryChanged(): void {
    this.deepChatRuntime.markToolRegistryChanged()
  }

  assertNoActivePendingInputs(sessionId: string): void {
    this.pendingInputAdmission.assertNoActiveInputs(sessionId)
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

}
