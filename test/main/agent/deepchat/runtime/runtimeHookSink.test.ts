import type { HookNotification, HookObserver } from '@/hook/observer'
import { RuntimeHookSink } from '@/agent/deepchat/runtime/runtimeHookSink'
import type { DeepChatSessionState } from '@shared/types/agent-interface'
import { afterEach, describe, expect, it, vi } from 'vitest'

const STATE: DeepChatSessionState = {
  status: 'idle',
  providerId: 'openai',
  modelId: 'gpt-5',
  permissionMode: 'full_access'
}

function createHarness() {
  const notifications: HookNotification[] = []
  const observer: HookObserver = {
    notify: vi.fn((notification: HookNotification) => notifications.push(notification))
  }
  const getSessionAgentId = vi.fn().mockReturnValue('agent-id')
  const resolveProjectDir = vi.fn().mockReturnValue('/workspace')
  const sink = new RuntimeHookSink({
    observer,
    getSessionAgentId,
    resolveProjectDir
  })
  return { getSessionAgentId, notifications, observer, resolveProjectDir, sink }
}

describe('RuntimeHookSink', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds the current agent identity without changing the hook context', () => {
    const { notifications, sink } = createHarness()

    sink.dispatch('UserPromptSubmit', {
      sessionId: 'session',
      messageId: 'message',
      promptPreview: 'prompt'
    })

    expect(notifications).toEqual([
      {
        event: 'UserPromptSubmit',
        context: {
          sessionId: 'session',
          messageId: 'message',
          promptPreview: 'prompt',
          agentId: 'agent-id'
        }
      }
    ])
  })

  it('isolates observer failures from runtime settlement', () => {
    const { observer, sink } = createHarness()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(observer.notify).mockImplementationOnce(() => {
      throw new Error('observer failed')
    })

    expect(() => sink.dispatch('SessionStart', { sessionId: 'session' })).not.toThrow()
    expect(warning).toHaveBeenCalledWith(
      '[DeepChatAgent] Failed to dispatch SessionStart hook:',
      expect.objectContaining({ message: 'observer failed' })
    )
  })

  it('maps a completed terminal result to Stop then SessionEnd', () => {
    const { notifications, resolveProjectDir, sink } = createHarness()

    sink.observeTerminal('session', STATE, {
      status: 'completed',
      stopReason: 'tool_calls_complete',
      usage: { totalTokens: 12 }
    })

    expect(notifications).toEqual([
      {
        event: 'Stop',
        context: {
          sessionId: 'session',
          providerId: 'openai',
          modelId: 'gpt-5',
          projectDir: '/workspace',
          stop: { reason: 'tool_calls_complete', userStop: false },
          agentId: 'agent-id'
        }
      },
      {
        event: 'SessionEnd',
        context: {
          sessionId: 'session',
          providerId: 'openai',
          modelId: 'gpt-5',
          projectDir: '/workspace',
          usage: { totalTokens: 12 },
          error: null,
          agentId: 'agent-id'
        }
      }
    ])
    expect(resolveProjectDir).toHaveBeenCalledTimes(2)
  })

  it('maps abort and error fallbacks while ignoring paused results', () => {
    const { notifications, sink } = createHarness()

    sink.observeTerminal('session', STATE, { status: 'paused' })
    sink.observeTerminal('session', STATE, { status: 'aborted' })
    sink.observeTerminal('session', STATE, {
      status: 'error',
      terminalError: 'provider failed'
    })

    expect(notifications.map(({ event, context }) => ({
      event,
      stop: context.stop,
      error: context.error
    }))).toEqual([
      {
        event: 'Stop',
        stop: { reason: 'user_stop', userStop: true },
        error: undefined
      },
      { event: 'SessionEnd', stop: undefined, error: null },
      {
        event: 'Stop',
        stop: { reason: 'error', userStop: false },
        error: undefined
      },
      {
        event: 'SessionEnd',
        stop: undefined,
        error: { message: 'provider failed' }
      }
    ])
  })
})
