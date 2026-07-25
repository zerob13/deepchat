import type { DeepChatSessionState } from '@shared/types/agent-interface'
import type { HookEventName } from '@shared/hooksNotifications'
import type { HookContext, HookObserver } from '@/hook/observer'
import type { ProcessResult } from './types'

export type RuntimeHookContext = Omit<HookContext, 'agentId'>

export interface RuntimeHookSinkDependencies {
  observer: HookObserver
  getSessionAgentId(sessionId: string): string | undefined
  resolveProjectDir(sessionId: string): string | null
}

export class RuntimeHookSink {
  constructor(private readonly deps: RuntimeHookSinkDependencies) {}

  dispatch(event: HookEventName, context: RuntimeHookContext): void {
    try {
      this.deps.observer.notify({
        event,
        context: {
          ...context,
          agentId: this.deps.getSessionAgentId(context.sessionId) ?? 'deepchat'
        }
      })
    } catch (error) {
      console.warn(`[DeepChatAgent] Failed to dispatch ${event} hook:`, error)
    }
  }

  observeTerminal(
    sessionId: string,
    state: DeepChatSessionState | undefined,
    result: ProcessResult
  ): void {
    if (!state || result.status === 'paused') {
      return
    }

    this.dispatch('Stop', {
      sessionId,
      providerId: state.providerId,
      modelId: state.modelId,
      projectDir: this.deps.resolveProjectDir(sessionId),
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
    this.dispatch('SessionEnd', {
      sessionId,
      providerId: state.providerId,
      modelId: state.modelId,
      projectDir: this.deps.resolveProjectDir(sessionId),
      usage: result.usage ?? null,
      error:
        result.errorMessage || result.terminalError
          ? {
              message: result.errorMessage ?? result.terminalError
            }
          : null
    })
  }
}
