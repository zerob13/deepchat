import { describe, expect, it, vi } from 'vitest'
import { SessionEventRouter } from '@/events/sessionEventRouter'
import {
  TypedEventHub,
  TypedEventHubOverflowError,
  type TypedEventRecord
} from '@/events/typedEventHub'

function createHub(options: Partial<ConstructorParameters<typeof TypedEventHub>[0]> = {}): {
  hub: TypedEventHub
  broadcast: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
} {
  const broadcast = vi.fn()
  const send = vi.fn()
  return {
    hub: new TypedEventHub({
      renderer: { broadcast, send },
      epoch: 'test-epoch',
      now: () => 123,
      ...options
    }),
    broadcast,
    send
  }
}

async function nextEvent(events: AsyncIterable<TypedEventRecord>): Promise<TypedEventRecord> {
  const result = await events[Symbol.asyncIterator]().next()
  if (result.done) throw new Error('Expected an event')
  return result.value
}

describe('TypedEventHub', () => {
  it('delivers renderer targets without creating stream subscriptions', () => {
    const { hub, broadcast, send } = createHub()

    hub.publish(
      'sessions.status.changed',
      { sessionId: 'session-1', status: 'generating', version: 1 },
      { kind: 'renderer-all' }
    )
    hub.publish(
      'sessions.status.changed',
      { sessionId: 'session-2', status: 'idle', version: 2 },
      { kind: 'renderer', webContentsId: 7 }
    )

    expect(broadcast).toHaveBeenCalledWith({
      name: 'sessions.status.changed',
      payload: { sessionId: 'session-1', status: 'generating', version: 1 }
    })
    expect(send).toHaveBeenCalledWith(7, {
      name: 'sessions.status.changed',
      payload: { sessionId: 'session-2', status: 'idle', version: 2 }
    })
  })

  it('isolates run targets and replays retained events after a cursor', async () => {
    const { hub } = createHub()
    const runOne = hub.subscribe({ kind: 'run', runId: 'run-1' })
    const runTwo = hub.subscribe({ kind: 'run', runId: 'run-2' })

    hub.publish(
      'sessions.status.changed',
      { sessionId: 'run-1', status: 'generating', version: 1 },
      { kind: 'run', runId: 'run-1' }
    )
    const first = await nextEvent(runOne.events)
    expect(first.cursor).toBe('test-epoch:1')

    const replay = hub.subscribe(
      { kind: 'run', runId: 'run-1' },
      { afterCursor: runOne.initialCursor }
    )
    expect(replay.recoveryReason).toBeNull()
    await expect(nextEvent(replay.events)).resolves.toEqual(first)

    const runTwoIterator = runTwo.events[Symbol.asyncIterator]()
    const pendingRunTwo = runTwoIterator.next()
    runTwo.close()
    await expect(pendingRunTwo).resolves.toEqual({ value: undefined, done: true })
  })

  it('requires a snapshot when a cursor belongs to another process epoch', () => {
    const { hub } = createHub()
    const subscription = hub.subscribe(
      { kind: 'run', runId: 'run-1' },
      { afterCursor: 'old-epoch:42' }
    )

    expect(subscription.recoveryReason).toBe('server_restarted')
    expect(subscription.initialCursor).toBe('test-epoch:0')
  })

  it('terminates a slow subscriber instead of growing its queue', async () => {
    const { hub } = createHub({ maxSubscriberEvents: 1, maxSubscriberBytes: 64 * 1024 })
    const subscription = hub.subscribe({ kind: 'run', runId: 'run-1' })

    hub.publish(
      'sessions.status.changed',
      { sessionId: 'run-1', status: 'generating', version: 1 },
      { kind: 'run', runId: 'run-1' }
    )
    hub.publish(
      'sessions.status.changed',
      { sessionId: 'run-1', status: 'idle', version: 2 },
      { kind: 'run', runId: 'run-1' }
    )

    await expect(nextEvent(subscription.events)).rejects.toBeInstanceOf(TypedEventHubOverflowError)
  })

  it('rejects an oversized event even while the subscriber is waiting', async () => {
    const { hub } = createHub({ maxSubscriberBytes: 256 })
    const subscription = hub.subscribe({ kind: 'run', runId: 'run-1' })
    const pending = nextEvent(subscription.events)

    hub.publish(
      'chat.stream.failed',
      {
        requestId: 'request-1',
        sessionId: 'run-1',
        messageId: 'message-1',
        failedAt: 123,
        error: 'x'.repeat(512)
      },
      { kind: 'run', runId: 'run-1' }
    )

    await expect(pending).rejects.toBeInstanceOf(TypedEventHubOverflowError)
  })
})

describe('SessionEventRouter', () => {
  it('keeps CLI run content off all-window broadcasts', async () => {
    const { hub, broadcast, send } = createHub()
    const router = new SessionEventRouter({
      hub,
      resolveSessionRunId: (sessionId) => (sessionId === 'cli-run' ? 'cli-run' : null),
      getBoundRendererIds: (sessionId) => (sessionId === 'cli-run' ? [9] : [])
    })
    const subscription = hub.subscribe({ kind: 'run', runId: 'cli-run' })

    router.publish('chat.stream.updated', {
      kind: 'snapshot',
      requestId: 'request-1',
      sessionId: 'cli-run',
      messageId: 'message-1',
      updatedAt: 123,
      blocks: []
    })

    expect(broadcast).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(9, {
      name: 'chat.stream.updated',
      payload: {
        kind: 'snapshot',
        requestId: 'request-1',
        sessionId: 'cli-run',
        messageId: 'message-1',
        updatedAt: 123,
        blocks: []
      }
    })
    await expect(nextEvent(subscription.events)).resolves.toMatchObject({
      target: { kind: 'run', runId: 'cli-run' },
      event: 'chat.stream.updated'
    })
  })

  it('keeps CLI runs discoverable without broadcasting their transcript content', () => {
    const { hub, broadcast, send } = createHub()
    const router = new SessionEventRouter({
      hub,
      resolveSessionRunId: (sessionId) => (sessionId === 'cli-run' ? 'cli-run' : null),
      getBoundRendererIds: () => [9]
    })

    router.publish('sessions.updated', {
      sessionIds: ['normal', 'cli-run'],
      reason: 'updated'
    })

    expect(broadcast).toHaveBeenCalledWith({
      name: 'sessions.updated',
      payload: { sessionIds: ['normal', 'cli-run'], reason: 'updated' }
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('suppresses full transcript notifications from CLI event streams', async () => {
    const { hub, broadcast, send } = createHub()
    const router = new SessionEventRouter({
      hub,
      resolveSessionRunId: () => 'cli-run',
      getBoundRendererIds: () => [9]
    })
    const subscription = hub.subscribe({ kind: 'run', runId: 'cli-run' })

    router.publish('sessions.messages.changed', {
      sessionId: 'cli-run',
      messages: [],
      version: 1
    })

    expect(broadcast).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    const iterator = subscription.events[Symbol.asyncIterator]()
    const pending = iterator.next()
    subscription.close()
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
  })

  it('routes descendant session events to the root CLI run', async () => {
    const { hub, broadcast } = createHub()
    const resolveSessionRunId = vi.fn((sessionId: string) =>
      sessionId === 'child-session' ? 'root-run' : null
    )
    const router = new SessionEventRouter({
      hub,
      resolveSessionRunId,
      getBoundRendererIds: () => []
    })
    const subscription = hub.subscribe({ kind: 'run', runId: 'root-run' })

    router.publish('chat.stream.completed', {
      requestId: 'request-1',
      sessionId: 'child-session',
      messageId: 'message-1',
      completedAt: 123
    })
    router.publish('sessions.status.changed', {
      sessionId: 'child-session',
      status: 'idle',
      version: 2
    })

    expect(broadcast).not.toHaveBeenCalled()
    expect(resolveSessionRunId).toHaveBeenCalledTimes(1)
    await expect(nextEvent(subscription.events)).resolves.toMatchObject({
      target: { kind: 'run', runId: 'root-run' },
      event: 'chat.stream.completed'
    })
    await expect(nextEvent(subscription.events)).resolves.toMatchObject({
      target: { kind: 'run', runId: 'root-run' },
      event: 'sessions.status.changed'
    })
  })

  it('fails closed for late events from an unknown or deleted session', () => {
    const { hub, broadcast, send } = createHub()
    const router = new SessionEventRouter({
      hub,
      resolveSessionRunId: () => undefined,
      getBoundRendererIds: () => []
    })

    router.publish('chat.stream.failed', {
      requestId: 'request-1',
      sessionId: 'deleted-session',
      messageId: 'message-1',
      failedAt: 123,
      error: 'late failure'
    })

    expect(broadcast).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
