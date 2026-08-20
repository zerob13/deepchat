import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from 'node-pty'
import type { AcpMaterializedLaunch } from '../runtime/acpProcessManager'

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
}

export class AcpTerminalAuthRunner {
  private readonly runs = new Map<string, AcpTerminalAuthRun>()

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
      completion
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
      this.runs.delete(runId)
      resolveExit({ exitCode, signal, cancelled: run.cancelled })
    })
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
    run.cancelled = true
    run.pty.kill()
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
    for (const run of this.runs.values()) {
      run.cancelled = true
      run.pty.kill()
    }
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
