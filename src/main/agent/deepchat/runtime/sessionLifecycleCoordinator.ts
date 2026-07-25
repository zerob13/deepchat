import logger from '@shared/logger'
import type {
  PermissionMode,
  SessionGenerationSettings
} from '@shared/types/agent-interface'
import type { ToolServicePort } from '@shared/types/tool'
import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import type { ProviderModelResolutionPort } from '@/provider/settings'
import type { PromptSettings } from '@/agent/promptSettings'
import type { DeepChatAgentRuntime } from '@/agent/deepchat/instance/deepChatAgentRuntime'
import type { MemoryRuntimeCoordinator } from '@/agent/deepchat/memory/memoryRuntimeCoordinator'
import type { SessionSettingsStore } from '@/session/data/settings'
import type { SessionTranscript } from '@/session/data/transcript'
import type { SessionPendingInputs } from '@/session/data/pendingInputs'
import type { CompactionRuntimeCoordinator } from './compactionRuntimeCoordinator'
import { sanitizeGenerationSettings } from './generationSettings'
import type { RunLifecycleCoordinator } from './runLifecycleCoordinator'
import type { SessionIdentityService } from './sessionIdentityService'
import type { SessionSettingsCoordinator } from './sessionSettingsCoordinator'

export interface SessionInitConfig {
  agentId?: string
  providerId: string
  modelId: string
  projectDir?: string | null
  permissionMode?: PermissionMode
  generationSettings?: Partial<SessionGenerationSettings>
}

export type SessionLifecycleRegistry = Pick<
  DeepChatAgentRuntime,
  'getOrHydrate' | 'getHydrated' | 'evict'
>

export interface SessionLifecycleCoordinatorDependencies {
  registry: SessionLifecycleRegistry
  providerSettings: ProviderModelResolutionPort
  promptSettings: Pick<PromptSettings, 'getDefaultSystemPrompt'>
  sessionStore: Pick<SessionSettingsStore, 'create' | 'delete'>
  transcript: Pick<SessionTranscript, 'deleteBySession'>
  pendingInputs: Pick<SessionPendingInputs, 'deleteBySession'>
  toolService: Pick<ToolServicePort, 'clearConversationToolMapping'>
  identity: Pick<SessionIdentityService, 'getAgentId'>
  sessionSettings: Pick<SessionSettingsCoordinator, 'normalizeProjectDir'>
  compaction: Pick<CompactionRuntimeCoordinator, 'idleState'>
  memory: Pick<
    MemoryRuntimeCoordinator,
    'initializeSession' | 'beginSessionDestroy' | 'finishSessionDestroy'
  >
  runLifecycle: Pick<
    RunLifecycleCoordinator,
    'clearFirstTurnReady' | 'cancelScopeOperations' | 'scopeFor'
  >
}

export class SessionLifecycleCoordinator {
  constructor(private readonly deps: SessionLifecycleCoordinatorDependencies) {}

  async init(sessionId: string, config: SessionInitConfig): Promise<void> {
    const projectDir = this.deps.sessionSettings.normalizeProjectDir(config.projectDir)
    const permissionMode = config.permissionMode ?? 'default'
    logger.info(
      `[DeepChatAgent] initSession id=${sessionId} provider=${config.providerId} model=${config.modelId} permission=${permissionMode} hasProjectDir=${projectDir !== null}`
    )
    const generationSettings = await sanitizeGenerationSettings(
      this.deps.providerSettings,
      this.deps.promptSettings,
      config.providerId,
      config.modelId,
      config.generationSettings ?? {}
    )
    this.deps.sessionStore.create(
      sessionId,
      config.providerId,
      config.modelId,
      permissionMode,
      generationSettings
    )
    const instance = this.deps.registry.getOrHydrate(toAppSessionId(sessionId))
    instance.setAgentId(
      config.agentId?.trim() || this.deps.identity.getAgentId(sessionId) || 'deepchat'
    )
    instance.setProjectDir(projectDir)
    instance.setGenerationSettings(generationSettings)
    instance.setRuntimeState({
      status: 'idle',
      providerId: config.providerId,
      modelId: config.modelId,
      permissionMode
    })
    instance.setCompactionState(this.deps.compaction.idleState())
    this.deps.memory.initializeSession(sessionId)
    this.deps.runLifecycle.clearFirstTurnReady(sessionId)
    instance.invalidateToolProfileCache()
  }

  async destroy(sessionId: string): Promise<void> {
    const instance = this.deps.registry.getHydrated(toAppSessionId(sessionId))
    this.deps.memory.beginSessionDestroy(sessionId)
    if (instance) {
      this.deps.runLifecycle.cancelScopeOperations(
        this.deps.runLifecycle.scopeFor(sessionId, instance)
      )
    }
    this.deps.runLifecycle.clearFirstTurnReady(sessionId)

    this.deps.pendingInputs.deleteBySession(sessionId)
    this.deps.transcript.deleteBySession(sessionId)
    this.deps.sessionStore.delete(sessionId)
    instance?.clearOwnedState()
    this.deps.registry.evict(toAppSessionId(sessionId))
    this.deps.memory.finishSessionDestroy(sessionId)
    this.deps.toolService.clearConversationToolMapping(sessionId)
  }
}
