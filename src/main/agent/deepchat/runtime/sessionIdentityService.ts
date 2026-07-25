import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import type { DeepChatAgentRuntime } from '@/agent/deepchat/instance/deepChatAgentRuntime'
import type { SessionDatabase } from '@/session/data/database'

export type SessionIdentityRegistry = Pick<DeepChatAgentRuntime, 'getHydrated'>

export interface SessionIdentityServiceDependencies {
  registry: SessionIdentityRegistry
  database: Pick<SessionDatabase, 'newSessionsTable'>
}

export class SessionIdentityService {
  constructor(private readonly deps: SessionIdentityServiceDependencies) {}

  getAgentId(sessionId: string): string | undefined {
    const instance = this.deps.registry.getHydrated(toAppSessionId(sessionId))
    const cached = instance?.getAgentId()?.trim()
    if (cached) {
      return cached
    }

    const persisted = this.deps.database.newSessionsTable?.get(sessionId)?.agent_id?.trim()
    if (persisted) {
      instance?.setAgentId(persisted)
      return persisted
    }

    return undefined
  }

  isAcpBackedSubagentSession(sessionId: string, providerId?: string): boolean {
    const sessionRow = this.deps.database.newSessionsTable?.get(sessionId)
    if (!sessionRow || sessionRow.session_kind !== 'subagent') {
      return false
    }

    const resolvedProviderId =
      providerId?.trim() ||
      this.deps.registry.getHydrated(toAppSessionId(sessionId))?.getRuntimeState()?.providerId
        ?.trim() ||
      ''
    return resolvedProviderId === 'acp'
  }
}
