import type { ProviderModelResolutionPort } from '@/provider/settings'
import type {
  DeepChatSessionState,
  PermissionMode,
  SessionAgentContextUpdate,
  SessionGenerationSettings
} from '@shared/types/agent-interface'

import type { ToolServicePort } from '@shared/types/tool'
import type { DeepChatAgentInstance } from '@/agent/deepchat/instance/deepChatAgentInstance'
import { BUILTIN_DEEPCHAT_AGENT_ID } from '@/agent/deepchat/deepChatAgentRepository'
import type { SessionPermissionPort } from '@/session/contracts'
import {
  buildPersistedGenerationSettingsPatch,
  buildPersistedGenerationSettingsReplacement,
  mapPersistedGenerationPatch,
  sanitizeGenerationSettings,
  type PersistedSessionGenerationRow
} from './generationSettings'
import type { SessionSettingsStore } from '@/session/data/settings'
import type { DeepChatToolResolver } from './toolResolver'
import type { PromptSettings } from '@/agent/promptSettings'

interface SessionSettingsCoordinatorDependencies {
  providerSettings: ProviderModelResolutionPort
  promptSettings: Pick<PromptSettings, 'getDefaultSystemPrompt'>
  sessionStore: SessionSettingsStore
  toolResolver: DeepChatToolResolver
  toolService: ToolServicePort
  sessionPermissionPort: SessionPermissionPort
  getRuntimeState(sessionId: string): DeepChatSessionState | undefined
  getSessionAgentId(sessionId: string): string | undefined
  getInstance(sessionId: string): DeepChatAgentInstance
  getHydratedInstance(sessionId: string): DeepChatAgentInstance | undefined
  assertCurrent(sessionId: string, instance: DeepChatAgentInstance): void
  beginSessionAgentReassignment(sessionId: string): Promise<void>
  finishSessionAgentReassignment(sessionId: string): void
  readPersistedProjectDir(sessionId: string): string | null | undefined
}

export class SessionSettingsCoordinator {
  constructor(private readonly deps: SessionSettingsCoordinatorDependencies) {}

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const state = this.deps.getRuntimeState(sessionId)
    this.deps.sessionStore.updatePermissionMode(sessionId, mode)
    if (state) {
      state.permissionMode = mode
    }
  }

  async setModel(sessionId: string, providerId: string, modelId: string): Promise<void> {
    const nextProviderId = providerId?.trim()
    const nextModelId = modelId?.trim()
    if (!nextProviderId || !nextModelId) {
      throw new Error('Session model update requires providerId and modelId.')
    }

    const state = this.deps.getRuntimeState(sessionId)
    const dbSession = this.deps.sessionStore.get(sessionId)
    if (!state && !dbSession) {
      throw new Error(`Session ${sessionId} not found`)
    }
    const permissionMode = state?.permissionMode ?? dbSession?.permission_mode
    if (!permissionMode) {
      throw new Error(`Session ${sessionId} permission mode is missing`)
    }
    if (state?.status === 'generating') {
      throw new Error('Cannot switch model while session is generating.')
    }

    const currentGeneration = await this.getEffectiveGenerationSettings(sessionId)
    const sanitized = await sanitizeGenerationSettings(
      this.deps.providerSettings,
      this.deps.promptSettings,
      nextProviderId,
      nextModelId,
      { systemPrompt: currentGeneration.systemPrompt }
    )
    this.deps.sessionStore.updateSessionConfiguration(
      sessionId,
      nextProviderId,
      nextModelId,
      buildPersistedGenerationSettingsReplacement(sanitized)
    )

    const instance = this.deps.getInstance(sessionId)
    if (state) {
      state.providerId = nextProviderId
      state.modelId = nextModelId
    } else {
      instance.setRuntimeState({
        status: 'idle',
        providerId: nextProviderId,
        modelId: nextModelId,
        permissionMode
      })
    }
    instance.setGenerationSettings(sanitized)
    this.invalidateToolProfile(sessionId)
  }

  async setAgentContext(sessionId: string, config: SessionAgentContextUpdate): Promise<void> {
    const nextProviderId = config.providerId?.trim()
    const nextModelId = config.modelId?.trim()
    const nextAgentId = config.agentId?.trim()
    if (!nextAgentId || !nextProviderId || !nextModelId) {
      throw new Error('Session agent context update requires agentId, providerId and modelId.')
    }

    const state = this.deps.getRuntimeState(sessionId)
    const dbSession = this.deps.sessionStore.get(sessionId)
    if (!state && !dbSession) {
      throw new Error(`Session ${sessionId} not found`)
    }
    if (state?.status === 'generating') {
      throw new Error('Cannot move session while it is generating.')
    }

    const permissionMode = config.permissionMode
    const generationSettings = await sanitizeGenerationSettings(
      this.deps.providerSettings,
      this.deps.promptSettings,
      nextProviderId,
      nextModelId,
      config.generationSettings ?? {}
    )
    const isAgentReassignment =
      (this.deps.getSessionAgentId(sessionId) ?? BUILTIN_DEEPCHAT_AGENT_ID) !== nextAgentId
    try {
      if (isAgentReassignment) {
        await this.deps.beginSessionAgentReassignment(sessionId)
      }
      this.deps.sessionStore.updateSessionConfiguration(
        sessionId,
        nextProviderId,
        nextModelId,
        buildPersistedGenerationSettingsReplacement(generationSettings),
        permissionMode
      )

      const instance = this.deps.getInstance(sessionId)
      instance.setRuntimeState({
        status: state?.status ?? 'idle',
        providerId: nextProviderId,
        modelId: nextModelId,
        permissionMode
      })
      instance.setAgentId(nextAgentId)
      instance.setProjectDir(this.normalizeProjectDir(config.projectDir))
      instance.setGenerationSettings(generationSettings)
      this.deps.sessionPermissionPort.clearSessionPermissions(sessionId)
      this.deps.toolService.clearAgentPlanState(sessionId)
      instance.replaceRuntimeActivatedSkills([])
      await this.deps.toolResolver.revalidateActiveSkillsForAgent(sessionId, nextAgentId)
      this.invalidateToolProfile(sessionId)
    } finally {
      if (isAgentReassignment) {
        this.deps.finishSessionAgentReassignment(sessionId)
      }
    }
  }

  setProjectDir(sessionId: string, projectDir: string | null): void {
    const normalized = this.normalizeProjectDir(projectDir)
    const instance = this.deps.getInstance(sessionId)
    const previous = instance.hasProjectDir()
      ? instance.getProjectDir()
      : this.resolvePersistedProjectDir(sessionId)
    instance.setProjectDir(normalized)
    if (previous !== normalized) {
      this.invalidateToolProfile(sessionId)
    }
  }

  resolveProjectDir(
    sessionId: string,
    incoming?: string | null,
    expectedInstance = this.deps.getInstance(sessionId)
  ): string | null {
    this.deps.assertCurrent(sessionId, expectedInstance)
    if (incoming !== undefined) {
      const normalized = this.normalizeProjectDir(incoming)
      const previous = expectedInstance.hasProjectDir()
        ? expectedInstance.getProjectDir()
        : this.resolvePersistedProjectDir(sessionId)
      expectedInstance.setProjectDir(normalized)
      if (previous !== normalized) {
        expectedInstance.invalidateToolProfileCache()
      }
      return normalized
    }
    if (expectedInstance.hasProjectDir()) {
      return expectedInstance.getProjectDir()
    }

    const persisted = this.resolvePersistedProjectDir(sessionId)
    expectedInstance.setProjectDir(persisted)
    return persisted
  }

  normalizeProjectDir(projectDir?: string | null): string | null {
    const normalized = projectDir?.trim()
    return normalized ? normalized : null
  }

  getPermissionMode(sessionId: string): PermissionMode {
    const state = this.deps.getRuntimeState(sessionId)
    if (state) {
      return state.permissionMode
    }
    return this.deps.sessionStore.get(sessionId)?.permission_mode ?? 'default'
  }

  async getGenerationSettings(sessionId: string): Promise<SessionGenerationSettings | null> {
    const state = this.deps.getRuntimeState(sessionId)
    const dbSession = this.deps.sessionStore.get(sessionId)
    if (!state && !dbSession) {
      return null
    }
    return await this.getEffectiveGenerationSettings(sessionId)
  }

  async updateGenerationSettings(
    sessionId: string,
    settings: Partial<SessionGenerationSettings>
  ): Promise<SessionGenerationSettings> {
    const state = this.deps.getRuntimeState(sessionId)
    const dbSession = this.deps.sessionStore.get(sessionId)
    if (!state && !dbSession) {
      throw new Error(`Session ${sessionId} not found`)
    }
    const providerId = state?.providerId ?? dbSession?.provider_id
    const modelId = state?.modelId ?? dbSession?.model_id
    if (!providerId || !modelId) {
      throw new Error(`Session ${sessionId} model information is missing`)
    }

    const current = await this.getEffectiveGenerationSettings(sessionId)
    const sanitized = await sanitizeGenerationSettings(
      this.deps.providerSettings,
      this.deps.promptSettings,
      providerId,
      modelId,
      settings,
      current
    )
    this.deps.sessionStore.updateGenerationSettings(
      sessionId,
      buildPersistedGenerationSettingsPatch(settings, sanitized)
    )
    this.deps.getInstance(sessionId).setGenerationSettings(sanitized)
    return sanitized
  }

  async getEffectiveGenerationSettings(
    sessionId: string,
    expectedInstance = this.deps.getInstance(sessionId)
  ): Promise<SessionGenerationSettings> {
    this.deps.assertCurrent(sessionId, expectedInstance)
    const cached = expectedInstance.getGenerationSettings()
    if (cached) {
      return { ...cached }
    }

    const state = expectedInstance.getRuntimeState()
    const dbSession = this.deps.sessionStore.get(sessionId) as
      | PersistedSessionGenerationRow
      | undefined
    const providerId = state?.providerId ?? dbSession?.provider_id
    const modelId = state?.modelId ?? dbSession?.model_id

    if (!providerId || !modelId) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const persistedPatch = dbSession
      ? mapPersistedGenerationPatch(this.deps.providerSettings, dbSession)
      : {}
    const sanitized = await sanitizeGenerationSettings(
      this.deps.providerSettings,
      this.deps.promptSettings,
      providerId,
      modelId,
      persistedPatch
    )
    this.deps.assertCurrent(sessionId, expectedInstance)
    expectedInstance.setGenerationSettings(sanitized)
    return { ...sanitized }
  }

  private resolvePersistedProjectDir(sessionId: string): string | null {
    try {
      return this.normalizeProjectDir(this.deps.readPersistedProjectDir(sessionId))
    } catch (error) {
      console.warn('[DeepChatAgent] Failed to resolve persisted project directory:', {
        sessionId,
        error
      })
      return null
    }
  }

  private invalidateToolProfile(sessionId: string): void {
    this.deps.getHydratedInstance(sessionId)?.invalidateToolProfileCache()
  }
}
