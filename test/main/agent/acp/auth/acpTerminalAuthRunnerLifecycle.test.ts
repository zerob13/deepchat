import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ptyMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  kill: vi.fn(),
  exitListener: null as ((event: { exitCode: number; signal?: number }) => void) | null
}))

vi.mock('node-pty', () => ({ spawn: ptyMock.spawn }))

import { AcpTerminalAuthRunner } from '@/agent/acp/auth/acpTerminalAuthRunner'

function startRunner(platform: NodeJS.Platform) {
  const runner = new AcpTerminalAuthRunner(platform)
  const started = runner.start({
    ownerWebContentsId: 7,
    launch: { command: 'agent', args: ['login'], env: {}, cwd: '/workspace' },
    onData: vi.fn()
  })
  return { runner, started }
}

describe('AcpTerminalAuthRunner lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ptyMock.kill.mockReset()
    ptyMock.exitListener = null
    ptyMock.spawn.mockReset().mockReturnValue({
      kill: ptyMock.kill,
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn((listener) => {
        ptyMock.exitListener = listener
        return { dispose: vi.fn() }
      })
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it.each([
    ['cancel', 'darwin', true],
    ['cancel', 'win32', false],
    ['shutdown', 'darwin', true],
    ['shutdown', 'win32', false]
  ] as const)('terminates %s runs safely on %s', (_action, platform, shouldEscalate) => {
    const { runner, started } = startRunner(platform)

    if (_action === 'cancel') runner.cancel(started.runId, 7)
    else runner.shutdown()

    expect(ptyMock.kill).toHaveBeenCalledWith()
    vi.advanceTimersByTime(2_000)
    if (shouldEscalate) expect(ptyMock.kill).toHaveBeenLastCalledWith('SIGKILL')
    else expect(ptyMock.kill).toHaveBeenCalledOnce()
  })

  it('clears termination escalation when the PTY exits', async () => {
    const { runner, started } = startRunner('darwin')

    runner.cancel(started.runId, 7)
    ptyMock.exitListener?.({ exitCode: 0 })
    await expect(started.completion).resolves.toMatchObject({ cancelled: true })
    vi.advanceTimersByTime(2_000)

    expect(ptyMock.kill).toHaveBeenCalledOnce()
  })

  it('cancels a terminal authentication run after ten minutes', async () => {
    const { started } = startRunner('darwin')

    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(ptyMock.kill).toHaveBeenCalledWith()
    ptyMock.exitListener?.({ exitCode: 0 })

    await expect(started.completion).resolves.toMatchObject({ cancelled: true })
  })
})
