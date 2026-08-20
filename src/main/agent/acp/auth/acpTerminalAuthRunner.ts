import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from 'node-pty'
import type { AcpMaterializedLaunch } from '../runtime/acpProcessManager'

const AUTH_RUN_TIMEOUT_MS = 10 * 60 * 1000
const AUTH_KILL_GRACE_MS = 2 * 1000

export interface AcpTerminalAuthExit {
  exitCode: number
  signal?: number
  cancelled: boolean
}

interface AcpTerminalAuthRun {
  ownerWebContentsId: number
  pty: IPty
  cancelled: boolean
  completion: Promise<AcpTerminalAuthExit>
  timeout: ReturnType<typeof setTimeout> | null
  forceKillTimeout: ReturnType<typeof setTimeout> | null
}

export class AcpTerminalAuthRunner {
  private readonly runs = new Map<string, AcpTerminalAuthRun>()

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  start(input: {
    ownerWebContentsId: number
    launch: AcpMaterializedLaunch
    onData(runId: string, data: string): void
  }): { runId: string; completion: Promise<AcpTerminalAuthExit> } {
    const runId = randomUUID()
    const pty = spawn(input.launch.command, input.launch.args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: input.launch.cwd,
      env: input.launch.env
    })
    let resolveExit!: (exit: AcpTerminalAuthExit) => void
    const completion = new Promise<AcpTerminalAuthExit>((resolve) => {
      resolveExit = resolve
    })
    const run: AcpTerminalAuthRun = {
      ownerWebContentsId: input.ownerWebContentsId,
      pty,
      cancelled: false,
      completion,
      timeout: null,
      forceKillTimeout: null
    }
    this.runs.set(runId, run)
    const dataSubscription = pty.onData((data) => {
      for (let offset = 0; offset < data.length; offset += 65_536) {
        input.onData(runId, data.slice(offset, offset + 65_536))
      }
    })
    const exitSubscription = pty.onExit(({ exitCode, signal }) => {
      dataSubscription.dispose()
      exitSubscription.dispose()
      this.clearTimeouts(run)
      this.runs.delete(runId)
      resolveExit({ exitCode, signal, cancelled: run.cancelled })
    })
    if (this.runs.get(runId) === run) {
      run.timeout = setTimeout(() => this.terminate(runId, run), AUTH_RUN_TIMEOUT_MS)
      run.timeout.unref?.()
    }
    return { runId, completion }
  }

  write(runId: string, ownerWebContentsId: number, data: string): void {
    const run = this.requireOwnedRun(runId, ownerWebContentsId)
    run.pty.write(data)
  }

  cancel(runId: string, ownerWebContentsId: number): boolean {
    const run = this.runs.get(runId)
    if (!run) return false
    if (run.ownerWebContentsId !== ownerWebContentsId) {
      throw new Error('ACP authentication terminal belongs to another renderer')
    }
    this.terminate(runId, run)
    return true
  }

  cancelOwnedBy(ownerWebContentsId: number): void {
    for (const [runId, run] of this.runs) {
      if (run.ownerWebContentsId === ownerWebContentsId) {
        this.cancel(runId, ownerWebContentsId)
      }
    }
  }

  shutdown(): void {
    for (const [runId, run] of this.runs) {
      this.terminate(runId, run)
    }
  }

  private terminate(runId: string, run: AcpTerminalAuthRun): void {
    run.cancelled = true
    try {
      run.pty.kill()
    } catch {}
    if (this.platform === 'win32' || this.runs.get(runId) !== run || run.forceKillTimeout) {
      return
    }
    run.forceKillTimeout = setTimeout(() => {
      run.forceKillTimeout = null
      if (this.runs.get(runId) !== run) return
      try {
        run.pty.kill('SIGKILL')
      } catch {}
    }, AUTH_KILL_GRACE_MS)
    run.forceKillTimeout.unref?.()
  }

  private clearTimeouts(run: AcpTerminalAuthRun): void {
    if (run.timeout) clearTimeout(run.timeout)
    if (run.forceKillTimeout) clearTimeout(run.forceKillTimeout)
    run.timeout = null
    run.forceKillTimeout = null
  }

  private requireOwnedRun(runId: string, ownerWebContentsId: number): AcpTerminalAuthRun {
    const run = this.runs.get(runId)
    if (!run) throw new Error('ACP authentication terminal is not running')
    if (run.ownerWebContentsId !== ownerWebContentsId) {
      throw new Error('ACP authentication terminal belongs to another renderer')
    }
    return run
  }
}
