import type { DeepChatSessionState, SessionGenerationSettings } from '@shared/types/agent-interface'
import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import type { DeepChatAgentRuntime } from '@/agent/deepchat/instance/deepChatAgentRuntime'
import type { SessionSettingsStore } from '@/session/data/settings'
import type { PersistedSessionGenerationRow } from './generationSettings'
import type { RunLifecycleCoordinator } from './runLifecycleCoordinator'
import type { SessionIdentityService } from './sessionIdentityService'

type SessionStateHydrationMode = 'full' | 'summary'

export type SessionStateRegistry = Pick<DeepChatAgentRuntime, 'getOrHydrate' | 'evict'>
export type SessionStateLifecyclePort = Pick<RunLifecycleCoordinator, 'hasPendingInteractions'>

export interface SessionStateGenerationSettingsPort {
  getEffectiveGenerationSettings(sessionId: string): Promise<SessionGenerationSettings>
}

export interface SessionStateResolverDependencies {
  registry: SessionStateRegistry
  sessionStore: Pick<SessionSettingsStore, 'get'>
  runLifecycle: SessionStateLifecyclePort
  identity: Pick<SessionIdentityService, 'getAgentId'>
  generationSettings: SessionStateGenerationSettingsPort
}

export class SessionStateResolver {
  constructor(private readonly deps: SessionStateResolverDependencies) {}

  // Entry points delegate without an extra async frame so callers keep their microtask ordering.
  get(sessionId: string): Promise<DeepChatSessionState | null> {
    return this.resolve(sessionId, 'full')
  }

  getSummary(sessionId: string): Promise<DeepChatSessionState | null> {
    return this.resolve(sessionId, 'summary')
  }

  private async resolve(
    sessionId: string,
    hydrationMode: SessionStateHydrationMode
  ): Promise<DeepChatSessionState | null> {
    const instance = this.deps.registry.getOrHydrate(toAppSessionId(sessionId))
    const state = instance.getRuntimeState()
    if (state) {
      this.deps.identity.getAgentId(sessionId)
      if (hydrationMode === 'full') {
        await this.deps.generationSettings.getEffectiveGenerationSettings(sessionId)
      }
      return {
        ...state,
        ...(this.deps.runLifecycle.hasPendingInteractions(sessionId)
          ? { status: 'generating' as const }
          : {})
      }
    }

    const dbSession = this.deps.sessionStore.get(sessionId) as
      | PersistedSessionGenerationRow
      | undefined
    if (!dbSession) {
      this.deps.registry.evict(toAppSessionId(sessionId))
      return null
    }

    this.deps.identity.getAgentId(sessionId)
    const hasPendingInteractions = this.deps.runLifecycle.hasPendingInteractions(sessionId)
    const rebuilt: DeepChatSessionState = {
      status: 'idle',
      providerId: dbSession.provider_id,
      modelId: dbSession.model_id,
      permissionMode: dbSession.permission_mode
    }
    instance.setRuntimeState(rebuilt)
    if (hydrationMode === 'full') {
      await this.deps.generationSettings.getEffectiveGenerationSettings(sessionId)
    }
    return {
      ...rebuilt,
      ...(hasPendingInteractions ? { status: 'generating' as const } : {})
    }
  }
}
