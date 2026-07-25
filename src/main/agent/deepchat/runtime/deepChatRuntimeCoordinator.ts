import type { ProviderModelResolutionPort } from '@/provider/settings'
import logger from '@shared/logger'
import type {
  DeepChatSessionState,
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
import type { SkillServicePort } from '@shared/types/skill'
import type { ProviderExecutionPort } from '@shared/types/provider'
import type { ToolServicePort } from '@shared/types/tool'
import type { SessionDatabase } from '@/session/data/database'
import type { PromptSettings } from '@/agent/promptSettings'
import type { AgentSettingsPort } from '@/agent/settings'
import { InputPreparationCoordinator } from '@/agent/deepchat/loop/inputPreparationCoordinator'
import { DeepChatContextCoordinator } from '@/agent/deepchat/loop/contextCoordinator'
import { DeepChatLoopRunner } from './deepChatLoopRunner'
import type { ToolExecutionPort, ToolResultPort } from '@/agent/deepchat/loop/ports'
import { DeepChatAgentRuntime } from '@/agent/deepchat/instance/deepChatAgentRuntime'
import {
  MemoryRuntimeCoordinator,
  type MemoryIngestionProjection
} from '@/agent/deepchat/memory/memoryRuntimeCoordinator'
import type { MemoryIngestionObserver } from '@/agent/deepchat/memory/memoryIngestionObserver'
import type { DeepChatAgentInstance } from '@/agent/deepchat/instance/deepChatAgentInstance'
import type { AgentSessionSendInput } from '@/agent/shared/agentSessionHandle'
import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import { CompactionService } from './compactionService'
import type { SessionData } from '@/session/data'
import type { MemoryRuntimePort } from '@/memory/injection'
import type { DeepChatEventPublisher } from './types'
import { ToolOutputGuard } from './toolOutputGuard'
import { createToolExecutionPort, createToolResultPort } from './toolAdapters'
import {
  createToolPermissionReviewer,
  createToolResultNormalizer,
  type ToolRuntimeBindingDependencies
} from './toolRuntimeBindings'
import { DeepChatToolResolver } from './toolResolver'
import { DeferredToolExecutor } from './deferredToolExecutor'
import { SessionSettingsCoordinator } from './sessionSettingsCoordinator'
import { CompactionRuntimeCoordinator } from './compactionRuntimeCoordinator'
import { ProviderPermissionCoordinator } from './providerPermissionCoordinator'
import { InteractionCoordinator } from './interactionCoordinator'
import { TurnCoordinator, type TurnStartContext } from './turnCoordinator'
import type { HookObserver } from '@/hook/observer'
import type {
  AcpAsLlmProviderPermissionPort,
  ProviderCatalogPort
} from '@/provider/ports'
import type { SessionPermissionPort, SessionUiPort } from '@/session/contracts'
import type { DeepChatSessionUpdatePublisher } from './types'
import type { AcpAgentInstanceDependencyFactory } from '@/agent/acp/instance'
import { createAcpCompatibilityDependencies } from '@/agent/acp/compatibility/dependencies'
import type { SkillSettingsPort } from '@/skill/settings'
import type { AgentTraceSettingsPort } from '@/agent/traceSettings'
import { SessionStatusPublisher } from './sessionStatusPublisher'
import { RunLifecycleCoordinator } from './runLifecycleCoordinator'
import type { AttachmentCapabilityRouter } from '@/ocr/attachmentCapabilityRouter'
import { PendingInputPump } from './pendingInputPump'
import { PendingInputAdmissionCoordinator } from './pendingInputAdmissionCoordinator'
import { RuntimeHookSink } from './runtimeHookSink'
import { createPendingInputWakeupBinding } from '@/agent/deepchat/harness/pendingInputWakeupBinding'
import { MessageProjectionService } from './messageProjectionService'
import { PromptAssemblyService } from './promptAssemblyService'
import { SessionIdentityService } from './sessionIdentityService'
import { SessionLifecycleCoordinator } from './sessionLifecycleCoordinator'
import { SessionStateResolver } from './sessionStateResolver'
import { TranscriptMutationCoordinator } from './transcriptMutationCoordinator'

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
  private readonly sessionStore: SessionData['settings']
  private readonly messageStore: SessionData['transcript']
  private readonly tapeService: SessionData['tapeStore']
  readonly deepChatRuntime: DeepChatAgentRuntime
  private readonly toolResolver: DeepChatToolResolver
  private readonly sessionSettingsCoordinator: SessionSettingsCoordinator
  private readonly compactionRuntimeCoordinator: CompactionRuntimeCoordinator
  private readonly deferredToolExecutor: DeferredToolExecutor
  private readonly loopRunner: DeepChatLoopRunner
  private readonly turnCoordinator: TurnCoordinator
  private readonly interactionCoordinator: InteractionCoordinator
  private readonly runtimeHookSink: RuntimeHookSink
  private readonly runLifecycle: RunLifecycleCoordinator
  private readonly pendingInputPump: PendingInputPump
  private readonly pendingInputAdmission: PendingInputAdmissionCoordinator
  private readonly memoryCoordinator: MemoryRuntimeCoordinator
  private readonly sessionIdentity: SessionIdentityService
  private readonly messageProjection: MessageProjectionService
  private readonly promptAssembly: PromptAssemblyService
  private readonly sessionStateResolver: SessionStateResolver
  private readonly sessionLifecycle: SessionLifecycleCoordinator
  private readonly transcriptMutation: TranscriptMutationCoordinator
  readonly memoryIngestionObserver: MemoryIngestionObserver
  private readonly traceSettings: AgentTraceSettingsPort
  private readonly publishEvent: DeepChatEventPublisher
  private readonly publishSessionUpdate: DeepChatSessionUpdatePublisher

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
    this.traceSettings = runtimePorts.traceSettings
    this.publishEvent = runtimePorts.publishEvent
    this.publishSessionUpdate = runtimePorts.publishSessionUpdate
    this.sessionStore = sessionData.settings
    this.messageStore = sessionData.transcript
    this.tapeService = sessionData.tapeStore
    const pendingInputCoordinator = sessionData.pendingInputs
    this.deepChatRuntime = new DeepChatAgentRuntime()
    this.sessionIdentity = new SessionIdentityService({
      registry: this.deepChatRuntime,
      database: sqlitePresenter
    })
    this.messageProjection = new MessageProjectionService({
      registry: this.deepChatRuntime,
      transcript: this.messageStore,
      publishEvent: this.publishEvent,
      publishSessionUpdate: this.publishSessionUpdate
    })
    this.toolResolver = new DeepChatToolResolver({
      agentSettings,
      skillSettings: runtimePorts.skillSettings,
      sqlitePresenter,
      toolService,
      skillService: runtimePorts.skillService,
      registry: this.deepChatRuntime,
      identity: this.sessionIdentity
    })
    this.memoryCoordinator = new MemoryRuntimeCoordinator({
      memoryPort: runtimePorts.memoryPort,
      registry: this.deepChatRuntime,
      identity: this.sessionIdentity,
      getNextMessageOrderSeq: (sessionId) => this.messageStore.getNextOrderSeq(sessionId),
      getMessagesUpToOrderSeq: (sessionId, orderSeq) =>
        this.messageStore.getMessagesUpToOrderSeq(sessionId, orderSeq),
      getMemoryCursorOrderSeq: (sessionId) =>
        sqlitePresenter.deepchatSessionsTable.getMemoryCursorOrderSeq(sessionId),
      updateMemoryCursorOrderSeq: (sessionId, orderSeq) =>
        sqlitePresenter.deepchatSessionsTable.updateMemoryCursorOrderSeq(sessionId, orderSeq),
      rewindMemoryCursorOrderSeq: (sessionId, orderSeq) =>
        sqlitePresenter.deepchatSessionsTable.rewindMemoryCursorOrderSeq(sessionId, orderSeq),
      tapeReader: this.tapeService,
      tapeAnchorWriter: this.tapeService,
      getIngestionProjection: runtimePorts.getMemoryIngestionProjection
    })
    this.memoryIngestionObserver = this.memoryCoordinator
    this.sessionSettingsCoordinator = new SessionSettingsCoordinator({
      providerSettings: this.providerSettings,
      promptSettings: runtimePorts.promptSettings,
      sessionStore: this.sessionStore,
      toolResolver: this.toolResolver,
      toolService,
      sessionPermissionPort: runtimePorts.sessionPermissionPort,
      registry: this.deepChatRuntime,
      identity: this.sessionIdentity,
      beginSessionAgentReassignment: async (sessionId) =>
        await this.memoryCoordinator.beginSessionAgentReassignment(sessionId),
      finishSessionAgentReassignment: (sessionId) =>
        this.memoryCoordinator.finishSessionAgentReassignment(sessionId),
      readPersistedProjectDir: (sessionId) =>
        sqlitePresenter.newSessionsTable?.get(sessionId)?.project_dir
    })
    this.promptAssembly = new PromptAssemblyService({
      registry: this.deepChatRuntime,
      providerSettings: this.providerSettings,
      skillSettings: runtimePorts.skillSettings,
      skillService: runtimePorts.skillService,
      providerCatalogPort: runtimePorts.providerCatalogPort,
      toolService,
      identity: this.sessionIdentity,
      projectDir: this.sessionSettingsCoordinator,
      memoryPromptContributor: this.memoryCoordinator
    })
    this.runtimeHookSink = new RuntimeHookSink({
      observer: hookObserver,
      identity: this.sessionIdentity,
      sessionSettings: this.sessionSettingsCoordinator
    })
    const pendingInputWakeupBinding = createPendingInputWakeupBinding()
    const sessionStatusPublisher = new SessionStatusPublisher({
      publishEvent: this.publishEvent,
      publishSessionUpdate: this.publishSessionUpdate,
      sessionUiPort: runtimePorts.sessionUiPort
    })
    this.runLifecycle = new RunLifecycleCoordinator({
      runtime: this.deepChatRuntime,
      statusPublisher: sessionStatusPublisher,
      transcript: this.messageStore,
      messageProjection: this.messageProjection,
      terminalObserver: this.runtimeHookSink,
      pendingInputWakeup: pendingInputWakeupBinding.wakeup
    })
    this.sessionStateResolver = new SessionStateResolver({
      registry: this.deepChatRuntime,
      sessionStore: this.sessionStore,
      runLifecycle: this.runLifecycle,
      identity: this.sessionIdentity,
      sessionSettings: this.sessionSettingsCoordinator
    })
    const providerPermissionCoordinator = new ProviderPermissionCoordinator({
      publishEvent: this.publishEvent,
      messageStore: this.messageStore,
      runLifecycle: this.runLifecycle,
      permissionPort: runtimePorts.acpAsLlmProviderPermission,
      messageProjection: this.messageProjection
    })
    const compactionService = new CompactionService(
      this.sessionStore,
      this.messageStore,
      this.providerRuntime,
      this.providerSettings,
      async (sessionId) => {
        const agentId = this.sessionIdentity.getAgentId(sessionId) ?? 'deepchat'
        return await agentSettings.resolveDeepChatAgentConfig(agentId)
      }
    )
    this.compactionRuntimeCoordinator = new CompactionRuntimeCoordinator({
      publishEvent: this.publishEvent,
      compactionService,
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      providerSettings: this.providerSettings,
      toolResolver: this.toolResolver,
      runLifecycle: this.runLifecycle,
      sessionSettings: this.sessionSettingsCoordinator,
      tapeReconciliation: this.tapeService,
      registry: this.deepChatRuntime,
      sessionState: this.sessionStateResolver,
      promptAssembly: this.promptAssembly,
      messageProjection: this.messageProjection
    })
    this.sessionLifecycle = new SessionLifecycleCoordinator({
      registry: this.deepChatRuntime,
      providerSettings: this.providerSettings,
      promptSettings: runtimePorts.promptSettings,
      sessionStore: this.sessionStore,
      transcript: this.messageStore,
      pendingInputs: pendingInputCoordinator,
      toolService,
      identity: this.sessionIdentity,
      sessionSettings: this.sessionSettingsCoordinator,
      compaction: this.compactionRuntimeCoordinator,
      memory: this.memoryCoordinator,
      runLifecycle: this.runLifecycle
    })
    const toolRuntimeBindings: ToolRuntimeBindingDependencies = {
      providerSettings: this.providerSettings,
      agentSettings,
      providerRuntime: this.providerRuntime,
      registry: this.deepChatRuntime,
      sessionStore: this.sessionStore,
      identity: this.sessionIdentity,
      runLifecycle: this.runLifecycle
    }
    const toolOutputGuard = new ToolOutputGuard()
    const toolExecutionPort: ToolExecutionPort = createToolExecutionPort(toolService)
    const toolResultPort: ToolResultPort = createToolResultPort({
      outputGuard: toolOutputGuard,
      normalize: createToolResultNormalizer(toolRuntimeBindings)
    })
    this.deferredToolExecutor = new DeferredToolExecutor({
      toolExecutionPort,
      toolResultPort,
      toolResolver: this.toolResolver,
      cacheImage: runtimePorts.cacheImage,
      runLifecycle: this.runLifecycle,
      sessionSettings: this.sessionSettingsCoordinator,
      sessionState: this.sessionStateResolver,
      identity: this.sessionIdentity,
      messageProjection: this.messageProjection
    })
    const inputPreparationCoordinator = new InputPreparationCoordinator()
    const contextCoordinator = new DeepChatContextCoordinator()
    this.loopRunner = new DeepChatLoopRunner({
      publishEvent: this.publishEvent,
      publishSessionUpdate: this.publishSessionUpdate,
      providerRuntime: this.providerRuntime,
      providerSettings: this.providerSettings,
      traceSettings: this.traceSettings,
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      tape: this.tapeService,
      pendingInputCoordinator,
      toolResolver: this.toolResolver,
      providerPermissionCoordinator,
      compactionService,
      inputPreparationCoordinator,
      contextCoordinator,
      memoryIngestionObserver: this.memoryIngestionObserver,
      toolExecutionPort,
      toolResultPort,
      cacheImage: runtimePorts.cacheImage,
      runLifecycle: this.runLifecycle,
      registry: this.deepChatRuntime,
      sessionSettings: this.sessionSettingsCoordinator,
      promptAssembly: this.promptAssembly,
      identity: this.sessionIdentity,
      sessionPermissionPort: runtimePorts.sessionPermissionPort,
      reviewToolPermission: createToolPermissionReviewer(toolRuntimeBindings),
      hookSink: this.runtimeHookSink,
      compaction: this.compactionRuntimeCoordinator
    })
    this.turnCoordinator = new TurnCoordinator({
      publishEvent: this.publishEvent,
      providerSettings: this.providerSettings,
      traceSettings: this.traceSettings,
      toolService,
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      tapeReconciliation: this.tapeService,
      toolResolver: this.toolResolver,
      compactionService,
      compactionRuntimeCoordinator: this.compactionRuntimeCoordinator,
      inputPreparationCoordinator,
      contextCoordinator,
      memoryCoordinator: this.memoryCoordinator,
      memoryIngestionObserver: this.memoryIngestionObserver,
      postCompactionPromptAssembler: this.promptAssembly.createPostCompactionPromptAssembler(),
      toolOutputGuard,
      runLifecycle: this.runLifecycle,
      registry: this.deepChatRuntime,
      attachmentRouter: runtimePorts.attachmentRouter,
      sessionSettings: this.sessionSettingsCoordinator,
      promptAssembly: this.promptAssembly,
      loopRunner: this.loopRunner,
      messageProjection: this.messageProjection,
      hookSink: this.runtimeHookSink
    })
    this.pendingInputPump = new PendingInputPump({
      pendingInputs: pendingInputCoordinator,
      transcript: this.messageStore,
      runLifecycle: this.runLifecycle,
      turnStarter: this.turnCoordinator,
      // Steer merging depends on an in-flight steerActiveTurn reaching the steer marker before a
      // settlement-triggered drain adopts the claim, and that window is currently defined only by
      // this read's async depth. The extra boundary is kept until the race is closed properly.
      sessionState: { get: async (sessionId) => await this.sessionStateResolver.get(sessionId) },
      sessionSettings: this.sessionSettingsCoordinator
    })
    pendingInputWakeupBinding.bind(this.pendingInputPump)
    this.pendingInputAdmission = new PendingInputAdmissionCoordinator({
      providerSettings: this.providerSettings,
      pendingInputs: pendingInputCoordinator,
      pump: this.pendingInputPump,
      runLifecycle: this.runLifecycle,
      attachmentRouter: runtimePorts.attachmentRouter,
      sessionState: this.sessionStateResolver,
      registry: this.deepChatRuntime,
      sessionSettings: this.sessionSettingsCoordinator
    })
    this.interactionCoordinator = new InteractionCoordinator({
      publishEvent: this.publishEvent,
      messageStore: this.messageStore,
      providerPermissionCoordinator,
      skillService: runtimePorts.skillService,
      runLifecycle: this.runLifecycle,
      registry: this.deepChatRuntime,
      sessionSettings: this.sessionSettingsCoordinator,
      sessionPermissionPort: runtimePorts.sessionPermissionPort,
      deferredToolExecutor: this.deferredToolExecutor,
      messageProjection: this.messageProjection,
      hookSink: this.runtimeHookSink,
      turnCoordinator: this.turnCoordinator
    })
    this.transcriptMutation = new TranscriptMutationCoordinator({
      registry: this.deepChatRuntime,
      sessionState: this.sessionStateResolver,
      sessionSettings: this.sessionSettingsCoordinator,
      admission: this.pendingInputAdmission,
      compaction: this.compactionRuntimeCoordinator,
      memory: this.memoryCoordinator,
      runLifecycle: this.runLifecycle
    })
    const recovered = this.messageStore.recoverPendingMessages()
    if (recovered > 0) {
      logger.info(`DeepChatAgent: recovered ${recovered} pending messages to error status`)
    }

    const recoveredPendingInputs = pendingInputCoordinator.recoverClaimedInputsAfterRestart()
    if (recoveredPendingInputs > 0) {
      logger.info(
        `DeepChatAgent: recovered ${recoveredPendingInputs} sessions with claimed pending inputs`
      )
    }
  }

  refreshToolRegistry(): void {
    this.deepChatRuntime.markToolRegistryChanged()
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
          await this.promptAssembly.build(sessionId, basePrompt, tools, activeSkills, instance),
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

  async send(sessionId: string, input: AgentSessionSendInput): Promise<MessageStartResult> {
    if (input.queue) {
      return await this.pendingInputAdmission.sendQueuedMessage(
        sessionId,
        input.content,
        input.queue,
        input.context
      )
    }
    return await this.processMessage(sessionId, input.content, input.context)
  }

  cleanupSession(sessionId: string): Promise<void> {
    return this.sessionLifecycle.cleanup(sessionId)
  }

  initSession(
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
    return this.sessionLifecycle.init(sessionId, config)
  }

  destroySession(sessionId: string): Promise<void> {
    return this.sessionLifecycle.destroy(sessionId)
  }

  async getSessionState(sessionId: string): Promise<DeepChatSessionState | null> {
    return await this.sessionStateResolver.get(sessionId)
  }

  async getSessionListState(sessionId: string): Promise<DeepChatSessionState | null> {
    return await this.sessionStateResolver.getSummary(sessionId)
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

  async getSessionCompactionState(sessionId: string): Promise<SessionCompactionState> {
    return await this.compactionRuntimeCoordinator.getState(sessionId)
  }

  async compactSession(
    sessionId: string
  ): Promise<{ compacted: boolean; state: SessionCompactionState }> {
    return await this.compactionRuntimeCoordinator.compact(sessionId)
  }

  prepareClearMessages(sessionId: string): Promise<void> {
    return this.transcriptMutation.prepareClearMessages(sessionId)
  }

  finishClearMessages(sessionId: string): void {
    this.transcriptMutation.finishClearMessages(sessionId)
  }

  prepareRetry(sessionId: string): Promise<{ projectDir: string | null }> {
    return this.transcriptMutation.prepareRetry(sessionId)
  }

  cancelForTranscriptMutation(sessionId: string): Promise<void> {
    return this.transcriptMutation.cancelForTranscriptMutation(sessionId)
  }

  invalidateTranscriptFrom(sessionId: string, orderSeq: number): void {
    this.transcriptMutation.invalidateTranscriptFrom(sessionId, orderSeq)
  }

  finishTranscriptTruncate(sessionId: string): void {
    this.transcriptMutation.finishTranscriptTruncate(sessionId)
  }

  resetForkTarget(targetSessionId: string): void {
    this.transcriptMutation.resetForkTarget(targetSessionId)
  }

  assertNoActivePendingInputs(sessionId: string): void {
    this.transcriptMutation.assertNoActivePendingInputs(sessionId)
  }
}
