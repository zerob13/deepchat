import type { ProviderExecutionPort } from '@shared/types/provider'
import type { ToolServicePort } from '@shared/types/tool'
import type { AgentSettingsPort } from '@/agent/settings'
import type { HookObserver } from '@/hook/observer'
import type { ProviderModelResolutionPort } from '@/provider/settings'
import type { SessionData } from '@/session/data'
import type { SessionDatabase } from '@/session/data/database'
import {
  createDeepChatRuntimeServices,
  DeepChatAgentHarness,
  type DeepChatHarnessDependencies
} from '@/agent/deepchat/harness'

export {
  PRE_STREAM_STUCK_ESCALATION_MS,
  PRE_STREAM_STUCK_WARN_MS
} from './preStreamWatchdog'

export type DeepChatRuntimeDependencies = Omit<
  DeepChatHarnessDependencies,
  | 'providerRuntime'
  | 'providerSettings'
  | 'agentSettings'
  | 'database'
  | 'sessionData'
  | 'toolService'
  | 'hookObserver'
>

/**
 * Positional-argument compatibility shim over the harness composition root. Removed once every
 * caller constructs {@link DeepChatAgentHarness} directly.
 */
export class DeepChatRuntimeCoordinator extends DeepChatAgentHarness {
  constructor(
    providerRuntime: ProviderExecutionPort,
    providerSettings: ProviderModelResolutionPort,
    agentSettings: AgentSettingsPort,
    database: SessionDatabase,
    sessionData: SessionData,
    toolService: ToolServicePort,
    runtimePorts: DeepChatRuntimeDependencies,
    hookObserver: HookObserver
  ) {
    super(
      createDeepChatRuntimeServices({
        ...runtimePorts,
        providerRuntime,
        providerSettings,
        agentSettings,
        database,
        sessionData,
        toolService,
        hookObserver
      })
    )
  }
}
