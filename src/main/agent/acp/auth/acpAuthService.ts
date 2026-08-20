import type { AcpAgentConfig, AcpAuthChallenge, AcpAuthRunStatus } from '@shared/types/acp'
import type { AgentSettingsPort } from '@/agent/settings'
import type { AcpRuntimeOwner } from '../client'
import { AcpTerminalAuthRunner } from './acpTerminalAuthRunner'
import { resolveAcpAgentAlias } from '@shared/utils/acpAgentAlias'

type AcpAuthEventName = 'acpAuth.output' | 'acpAuth.stateChanged'

export interface AcpAuthServiceDependencies {
  owner: AcpRuntimeOwner
  agentSettings: Pick<AgentSettingsPort, 'getAcpAgents'>
  sendToRenderer(webContentsId: number, name: AcpAuthEventName, payload: unknown): void
  onRendererDestroyed(webContentsId: number, callback: () => void): () => void
}

export class AcpAuthService {
  private readonly runner = new AcpTerminalAuthRunner()
  private readonly statuses = new Map<string, AcpAuthRunStatus & { ownerWebContentsId?: number }>()
  private readonly detachRendererListeners = new Map<string, () => void>()

  constructor(private readonly dependencies: AcpAuthServiceDependencies) {}

  async inspect(agentId: string, workdir?: string): Promise<AcpAuthChallenge> {
    const agent = await this.resolveAgent(agentId)
    const challenge = await this.dependencies.owner
      .getOrCreate()
      .processManager.inspectAuthentication(agent, workdir)
    this.statuses.set(challenge.id, {
      challengeId: challenge.id,
      state: 'required'
    })
    return challenge
  }

  async start(
    challengeId: string,
    methodId: string,
    ownerWebContentsId: number
  ): Promise<AcpAuthRunStatus> {
    const current = this.statuses.get(challengeId)
    if (current?.state === 'running' || current?.state === 'reconnecting') {
      if (current.ownerWebContentsId !== ownerWebContentsId) {
        throw new Error('ACP authentication is owned by another renderer')
      }
      return this.publicStatus(current)
    }

    const processManager = this.dependencies.owner.getOrCreate().processManager
    const challenge = processManager.getAuthChallenge(challengeId)
    const method = challenge.methods.find((candidate) => candidate.id === methodId)
    if (!method) throw new Error('ACP authentication method is unavailable')
    if (method.type === 'unsupported') {
      throw new Error('ACP authentication method is not supported by DeepChat')
    }

    if (method.type === 'agent') {
      this.setStatus(ownerWebContentsId, { challengeId, state: 'running' })
      try {
        await processManager.authenticateAgent(challengeId, methodId)
        return this.setStatus(ownerWebContentsId, { challengeId, state: 'succeeded' })
      } catch (error) {
        return this.setStatus(ownerWebContentsId, {
          challengeId,
          state: 'failed',
          error: this.toSafeError(error)
        })
      }
    }

    const prepared = await processManager.prepareTerminalAuthentication(challengeId, methodId)
    let started: ReturnType<AcpTerminalAuthRunner['start']>
    try {
      started = this.runner.start({
        ownerWebContentsId,
        launch: prepared.launch,
        onData: (runId, data) => {
          this.dependencies.sendToRenderer(ownerWebContentsId, 'acpAuth.output', {
            challengeId,
            runId,
            data,
            version: Date.now()
          })
        }
      })
    } catch (error) {
      processManager.abandonAuthentication(challengeId)
      return this.setStatus(ownerWebContentsId, {
        challengeId,
        state: 'failed',
        error: this.toSafeError(error)
      })
    }

    const status = this.setStatus(ownerWebContentsId, {
      challengeId,
      runId: started.runId,
      state: 'running'
    })
    this.detachRendererListeners.set(
      started.runId,
      this.dependencies.onRendererDestroyed(ownerWebContentsId, () => {
        this.runner.cancel(started.runId, ownerWebContentsId)
      })
    )
    void this.finishTerminalAuthentication(
      challengeId,
      started.runId,
      ownerWebContentsId,
      started.completion
    )
    return status
  }

  getStatus(challengeId: string, ownerWebContentsId: number): AcpAuthRunStatus {
    const status = this.statuses.get(challengeId)
    if (!status) return { challengeId, state: 'required' }
    if (
      status.ownerWebContentsId !== undefined &&
      status.ownerWebContentsId !== ownerWebContentsId
    ) {
      throw new Error('ACP authentication is owned by another renderer')
    }
    return this.publicStatus(status)
  }

  write(runId: string, ownerWebContentsId: number, data: string): void {
    this.runner.write(runId, ownerWebContentsId, data)
  }

  cancel(runId: string, ownerWebContentsId: number): boolean {
    return this.runner.cancel(runId, ownerWebContentsId)
  }

  shutdown(): void {
    this.runner.shutdown()
    this.detachRendererListeners.forEach((detach) => detach())
    this.detachRendererListeners.clear()
  }

  private async finishTerminalAuthentication(
    challengeId: string,
    runId: string,
    ownerWebContentsId: number,
    completion: Promise<{ exitCode: number; signal?: number; cancelled: boolean }>
  ): Promise<void> {
    const processManager = this.dependencies.owner.getOrCreate().processManager
    try {
      const exit = await completion
      if (exit.cancelled) {
        processManager.abandonAuthentication(challengeId)
        this.setStatus(ownerWebContentsId, {
          challengeId,
          runId,
          state: 'cancelled'
        })
        return
      }
      if (exit.signal) {
        processManager.abandonAuthentication(challengeId)
        this.setStatus(ownerWebContentsId, {
          challengeId,
          runId,
          state: 'failed',
          error: `Authentication process terminated by signal ${exit.signal}`
        })
        return
      }
      if (exit.exitCode !== 0) {
        processManager.abandonAuthentication(challengeId)
        this.setStatus(ownerWebContentsId, {
          challengeId,
          runId,
          state: 'failed',
          error: `Authentication process exited with code ${exit.exitCode}`
        })
        return
      }

      this.setStatus(ownerWebContentsId, {
        challengeId,
        runId,
        state: 'reconnecting'
      })
      await processManager.completeTerminalAuthentication(challengeId)
      this.setStatus(ownerWebContentsId, {
        challengeId,
        runId,
        state: 'succeeded'
      })
    } catch (error) {
      processManager.abandonAuthentication(challengeId)
      this.setStatus(ownerWebContentsId, {
        challengeId,
        runId,
        state: 'failed',
        error: this.toSafeError(error)
      })
    } finally {
      this.detachRendererListeners.get(runId)?.()
      this.detachRendererListeners.delete(runId)
    }
  }

  private async resolveAgent(agentId: string): Promise<AcpAgentConfig> {
    const canonicalId = resolveAcpAgentAlias(agentId)
    const agent = (await this.dependencies.agentSettings.getAcpAgents()).find(
      (candidate) => candidate.id === canonicalId
    )
    if (!agent) throw new Error(`ACP agent not found: ${canonicalId}`)
    return agent
  }

  private setStatus(ownerWebContentsId: number, status: AcpAuthRunStatus): AcpAuthRunStatus {
    this.statuses.set(status.challengeId, { ...status, ownerWebContentsId })
    this.dependencies.sendToRenderer(ownerWebContentsId, 'acpAuth.stateChanged', {
      ...status,
      version: Date.now()
    })
    return status
  }

  private publicStatus(
    status: AcpAuthRunStatus & { ownerWebContentsId?: number }
  ): AcpAuthRunStatus {
    const { ownerWebContentsId: _ownerWebContentsId, ...result } = status
    return result
  }

  private toSafeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
  }
}
