import type { AppSessionId } from '@/agent/shared/agentSessionIds'
import type { DeepChatSessionState } from '@shared/types/agent-interface'
import { DeepChatAgentInstance, type DeepChatAgentInstanceDelegate } from './deepChatAgentInstance'

export const STALE_DEEPCHAT_INSTANCE_ERROR_NAME = 'StaleDeepChatAgentInstanceError'

export function createStaleDeepChatInstanceError(sessionId: string): Error {
  const error = new Error(`DeepChat agent instance was replaced: ${sessionId}`)
  error.name = STALE_DEEPCHAT_INSTANCE_ERROR_NAME
  return error
}

export function isStaleDeepChatInstanceError(error: unknown): boolean {
  return error instanceof Error && error.name === STALE_DEEPCHAT_INSTANCE_ERROR_NAME
}

export interface SessionRuntimeScope {
  readonly sessionId: AppSessionId
  readonly instance: DeepChatAgentInstance

  state(): DeepChatSessionState | undefined
  isCurrent(): boolean
  assertCurrent(): void
}

export type DeepChatAgentInstanceHydrator = (
  sessionId: AppSessionId
) => DeepChatAgentInstanceDelegate

export class DeepChatAgentRuntime {
  private readonly instances = new Map<AppSessionId, DeepChatAgentInstance>()
  private readonly scopes = new WeakMap<DeepChatAgentInstance, SessionRuntimeScope>()
  private toolRegistryRevision = 0

  constructor(private readonly hydrateInstance: DeepChatAgentInstanceHydrator) {}

  getOrHydrate(sessionId: AppSessionId): DeepChatAgentInstance {
    const current = this.instances.get(sessionId)
    if (current) return current

    const instance = new DeepChatAgentInstance(
      sessionId,
      this.hydrateInstance(sessionId),
      (closedInstance) => {
        if (this.instances.get(sessionId) === closedInstance) {
          this.instances.delete(sessionId)
        }
      }
    )
    this.instances.set(sessionId, instance)
    return instance
  }

  getHydrated(sessionId: AppSessionId): DeepChatAgentInstance | undefined {
    return this.instances.get(sessionId)
  }

  getOrHydrateScope(sessionId: AppSessionId): SessionRuntimeScope {
    return this.scopeFor(sessionId, this.getOrHydrate(sessionId))
  }

  getHydratedScope(sessionId: AppSessionId): SessionRuntimeScope | undefined {
    const instance = this.instances.get(sessionId)
    return instance ? this.scopeFor(sessionId, instance) : undefined
  }

  scopeFor(sessionId: AppSessionId, instance: DeepChatAgentInstance): SessionRuntimeScope {
    if (instance.sessionId === sessionId) {
      const current = this.scopes.get(instance)
      if (current) {
        return current
      }
    }

    const scope: SessionRuntimeScope = {
      sessionId,
      instance,
      state: () => instance.getRuntimeState(),
      isCurrent: () => this.instances.get(sessionId) === instance,
      assertCurrent: () => {
        if (this.instances.get(sessionId) !== instance) {
          throw createStaleDeepChatInstanceError(sessionId)
        }
      }
    }
    if (instance.sessionId === sessionId) {
      this.scopes.set(instance, scope)
    }
    return scope
  }

  evict(sessionId: AppSessionId): boolean {
    return this.instances.delete(sessionId)
  }

  async dispose(sessionId: AppSessionId): Promise<void> {
    await this.instances.get(sessionId)?.close()
  }

  async cleanupSession(sessionId: AppSessionId): Promise<void> {
    const instance = this.instances.get(sessionId)
    if (!instance) return
    try {
      await instance.cancel()
    } finally {
      instance.clearOwnedState()
      if (this.instances.get(sessionId) === instance) this.instances.delete(sessionId)
    }
  }

  getToolRegistryRevision(): number {
    return this.toolRegistryRevision
  }

  markToolRegistryChanged(): void {
    this.toolRegistryRevision += 1
    for (const instance of this.instances.values()) {
      instance.invalidateToolProfileCache()
    }
  }
}
