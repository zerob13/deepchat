import logger from '@shared/logger'
import type {
  DeepChatSessionState,
  PendingInputEnqueueSource,
  PendingSessionInputRecord,
  SendMessageInput
} from '@shared/types/agent-interface'
import type { SessionRuntimeScope } from '@/agent/deepchat/instance/deepChatAgentRuntime'
import type { SessionPendingInputs } from '@/session/data/pendingInputs'
import type { SessionTranscript } from '@/session/data/transcript'
import { parseAssistantBlocks } from './interactionProjection'
import type { PendingInputWakeReason } from './runLifecycleCoordinator'
import type { RunLifecycleCoordinator } from './runLifecycleCoordinator'
import { redactRuntimeErrorForLog } from './runtimeErrorLogging'
import type {
  ClaimedInputDisposition,
  ClaimedPendingInputHandle,
  PendingInputTurnSource,
  TurnCompletion
} from './pendingInputContracts'

export type PendingInputPumpStorePort = Pick<
  SessionPendingInputs,
  | 'blockClaimedInput'
  | 'claimQueuedInput'
  | 'claimSteerInput'
  | 'consumeQueuedInput'
  | 'consumeSteerInput'
  | 'getInput'
  | 'getNextQueuedInput'
  | 'getNextSteerInput'
  | 'hasBlockingInput'
  | 'hasClaimedInput'
  | 'hasPendingTurnInput'
  | 'listPendingInputs'
  | 'releaseClaimedInput'
  | 'releaseClaimedQueueInput'
>

type PendingInputPumpLifecyclePort = Pick<
  RunLifecycleCoordinator,
  'getHydratedScope' | 'hasPendingInteractions'
>

export interface PendingInputTurnStarter {
  start(
    sessionId: string,
    content: SendMessageInput,
    context: PendingInputTurnContext
  ): Promise<TurnCompletion>
}

export interface PendingInputTurnContext {
  projectDir: string | null
  claimedInput: ClaimedPendingInputHandle
}

export interface PendingInputPumpPorts {
  pendingInputs: PendingInputPumpStorePort
  transcript: Pick<SessionTranscript, 'getMessages'>
  runLifecycle: PendingInputPumpLifecyclePort
  turnStarter: PendingInputTurnStarter
  getSessionState(sessionId: string): Promise<DeepChatSessionState | null>
  resolveProjectDir(sessionId: string): string | null
}

class DurablePendingInputClaim implements ClaimedPendingInputHandle {
  private settledDisposition: ClaimedInputDisposition | null = null

  constructor(
    private readonly pendingInputs: PendingInputPumpStorePort,
    private readonly sessionId: string,
    readonly id: string,
    readonly source: PendingInputTurnSource
  ) {}

  get disposition(): ClaimedInputDisposition | null {
    return this.settledDisposition
  }

  settle(disposition: ClaimedInputDisposition): PendingSessionInputRecord | null {
    if (this.settledDisposition) {
      throw new Error(
        `Pending input ${this.id} is already settled as ${this.settledDisposition.kind}`
      )
    }

    this.assertClaimed()
    try {
      const result = this.apply(disposition)
      this.settledDisposition = disposition
      return result
    } catch (error) {
      // SessionPendingInputs persists before publishing. If publication throws, remember the
      // durable outcome so Turn/Pump finalization never applies a second transition.
      if (this.wasApplied(disposition)) {
        this.settledDisposition = disposition
      }
      throw error
    }
  }

  private apply(disposition: ClaimedInputDisposition): PendingSessionInputRecord | null {
    switch (disposition.kind) {
      case 'consume':
        if (this.source === 'steer') {
          this.pendingInputs.consumeSteerInput(this.sessionId, this.id)
        } else {
          this.pendingInputs.consumeQueuedInput(this.sessionId, this.id)
        }
        return null
      case 'block':
        return this.pendingInputs.blockClaimedInput(
          this.sessionId,
          this.id,
          disposition.attachmentPreparation
        )
      case 'release-before-user-fact':
      case 'release-after-rollback':
        return this.source === 'steer'
          ? this.pendingInputs.releaseClaimedInput(this.sessionId, this.id)
          : this.pendingInputs.releaseClaimedQueueInput(this.sessionId, this.id)
    }
  }

  private assertClaimed(): void {
    const record = this.pendingInputs.getInput(this.sessionId, this.id)
    if (!record) {
      throw new Error(`Pending input not found: ${this.id}`)
    }
    const expectedMode = this.source === 'steer' ? 'steer' : 'queue'
    if (record.mode !== expectedMode) {
      throw new Error(`Pending input ${this.id} changed mode before settlement.`)
    }
    if (record.state !== 'claimed') {
      throw new Error(`Pending input ${this.id} is not claimed.`)
    }
  }

  private wasApplied(disposition: ClaimedInputDisposition): boolean {
    const record = this.pendingInputs.getInput(this.sessionId, this.id)
    const expectedMode = this.source === 'steer' ? 'steer' : 'queue'
    switch (disposition.kind) {
      case 'consume':
        return this.source === 'steer'
          ? record?.mode === expectedMode && record.state === 'consumed'
          : record === null
      case 'block':
        return record?.mode === expectedMode && record.state === 'blocked'
      case 'release-before-user-fact':
      case 'release-after-rollback':
        return record?.mode === expectedMode && record.state === 'pending'
    }
  }
}

export class PendingInputPump {
  constructor(private readonly ports: PendingInputPumpPorts) {}

  isAwaitingToolQuestionFollowUp(sessionId: string): boolean {
    const messages = this.ports.transcript.getMessages(sessionId)
    let latestUserOrderSeq = 0

    for (const message of messages) {
      if (message.role === 'user') {
        latestUserOrderSeq = Math.max(latestUserOrderSeq, message.orderSeq)
      }
    }

    return messages.some((message) => {
      if (message.role !== 'assistant' || message.orderSeq <= latestUserOrderSeq) {
        return false
      }

      return parseAssistantBlocks(message.content).some(
        (block) =>
          block.type === 'action' &&
          block.action_type === 'question_request' &&
          block.status === 'success' &&
          block.extra?.needsUserAction === false &&
          block.extra?.questionResolution === 'replied' &&
          block.extra?.questionFollowUpPending === true
      )
    })
  }

  shouldClaimImmediately(
    sessionId: string,
    status: DeepChatSessionState['status'],
    source: PendingInputEnqueueSource
  ): boolean {
    const instance = this.ports.runLifecycle.getHydratedScope(sessionId)?.instance
    const isUnclaimedQuestionFollowUp =
      source === 'send' &&
      this.isAwaitingToolQuestionFollowUp(sessionId) &&
      !this.ports.pendingInputs.hasBlockingInput(sessionId) &&
      !this.ports.pendingInputs.hasClaimedInput(sessionId) &&
      !instance?.isPendingQueueDraining()

    if (isUnclaimedQuestionFollowUp) {
      return true
    }
    if (!this.canDrain(sessionId, status, 'enqueue')) {
      return false
    }
    return (
      !this.ports.pendingInputs.hasPendingTurnInput(sessionId) &&
      !this.ports.pendingInputs.hasBlockingInput(sessionId) &&
      !this.ports.pendingInputs.hasClaimedInput(sessionId)
    )
  }

  canDrain(
    sessionId: string,
    status: DeepChatSessionState['status'],
    reason: PendingInputWakeReason
  ): boolean {
    if (!this.canDrainFromStatus(status, reason)) {
      return false
    }
    if (this.isAwaitingToolQuestionFollowUp(sessionId)) {
      return false
    }
    if (this.ports.runLifecycle.hasPendingInteractions(sessionId)) {
      return false
    }
    return !this.ports.runLifecycle
      .getHydratedScope(sessionId)
      ?.instance.isPendingQueueDraining()
  }

  startAcceptedInput(
    record: PendingSessionInputRecord,
    source: PendingInputEnqueueSource,
    projectDir: string | null
  ): void {
    if (record.mode !== 'queue' || record.state !== 'claimed') {
      throw new Error(`Accepted pending input ${record.id} is not a claimed queue input.`)
    }
    const scope = this.ports.runLifecycle.getHydratedScope(record.sessionId)
    const claim = this.createClaim(record.sessionId, record.id, source)
    if (!scope || scope.instance.isPendingQueueDraining()) {
      const released = this.tryRelease(claim)
      logger.error(
        `[DeepChatAgent] pending input start rejected session=${record.sessionId} stage=adopt-claim`
      )
      if (released) {
        this.schedule(record.sessionId, 'enqueue')
      }
      return
    }

    scope.instance.markPendingQueueDrainStarted()
    this.launch(scope, record, claim, projectDir, 'enqueue')
  }

  claimQueuedInputForPreparation(
    sessionId: string,
    itemId: string
  ): ClaimedPendingInputHandle {
    const claim = this.createClaim(sessionId, itemId, 'queue')
    try {
      this.ports.pendingInputs.claimQueuedInput(sessionId, itemId)
      return claim
    } catch (error) {
      this.tryRelease(claim)
      throw error
    }
  }

  async drain(sessionId: string, reason: PendingInputWakeReason): Promise<boolean> {
    const state = await this.ports.getSessionState(sessionId)
    if (!state || !this.canDrain(sessionId, state.status, reason)) {
      return false
    }
    const scope = this.ports.runLifecycle.getHydratedScope(sessionId)
    if (!scope) {
      return false
    }
    if (
      this.ports.pendingInputs.hasBlockingInput(sessionId) ||
      this.ports.pendingInputs.hasClaimedInput(sessionId)
    ) {
      return false
    }

    const nextSteerInput = this.ports.pendingInputs.getNextSteerInput(sessionId)
    const nextQueuedInput = nextSteerInput
      ? null
      : this.ports.pendingInputs.getNextQueuedInput(sessionId)
    const nextPendingInput = nextSteerInput ?? nextQueuedInput
    if (!nextPendingInput) {
      return false
    }

    let projectDir: string | null
    try {
      projectDir = this.ports.resolveProjectDir(sessionId)
    } catch (error) {
      this.logDrainError(sessionId, reason, 'resolve-project-dir', error)
      return false
    }

    const source: PendingInputTurnSource = nextSteerInput ? 'steer' : 'queue'
    const claim = this.createClaim(sessionId, nextPendingInput.id, source)
    scope.instance.markPendingQueueDrainStarted()

    let claimedInput: PendingSessionInputRecord
    try {
      claimedInput =
        source === 'steer'
          ? this.ports.pendingInputs.claimSteerInput(sessionId, nextPendingInput.id)
          : this.ports.pendingInputs.claimQueuedInput(sessionId, nextPendingInput.id)
    } catch (error) {
      // Publication can throw after the durable row changed to claimed.
      this.tryRelease(claim)
      scope.instance.markPendingQueueDrainFinished()
      this.logDrainError(sessionId, reason, 'claim-input', error)
      return false
    }

    try {
      scope.assertCurrent()
      if (source === 'steer') {
        scope.instance.clearActiveSteerPendingInputId(claimedInput.id)
      }
    } catch (error) {
      this.tryRelease(claim)
      scope.instance.markPendingQueueDrainFinished()
      this.logDrainError(sessionId, reason, 'adopt-claim', error)
      return false
    }

    this.launch(scope, claimedInput, claim, projectDir, reason)
    return true
  }

  schedule(sessionId: string, reason: PendingInputWakeReason): void {
    void this.drain(sessionId, reason).catch((error) => {
      logger.error(
        `[DeepChatAgent] drainPendingQueueIfPossible error session=${sessionId} reason=${reason}`,
        redactRuntimeErrorForLog(error)
      )
    })
  }

  private launch(
    scope: SessionRuntimeScope,
    claimedInput: PendingSessionInputRecord,
    claim: ClaimedPendingInputHandle,
    projectDir: string | null,
    reason: PendingInputWakeReason
  ): void {
    void this.ports.turnStarter
      .start(claimedInput.sessionId, claimedInput.payload, {
        projectDir,
        claimedInput: claim
      })
      .then((completion) => this.assertCompletionMatchesClaim(claimedInput.id, claim, completion))
      .catch((error) => {
        this.logDrainError(claimedInput.sessionId, reason, 'process-message', error)
      })
      .finally(async () => {
        if (!claim.disposition) {
          this.logDrainError(
            claimedInput.sessionId,
            reason,
            'unsettled-claim',
            new Error(`Turn left pending input ${claimedInput.id} unsettled.`)
          )
        }
        scope.instance.markPendingQueueDrainFinished()
        await this.scheduleNextIfReady(claimedInput.sessionId, claimedInput.id, reason)
      })
      .catch((error) => {
        this.logDrainError(claimedInput.sessionId, reason, 'finalization', error)
      })
  }

  private async scheduleNextIfReady(
    sessionId: string,
    claimedInputId: string,
    reason: PendingInputWakeReason
  ): Promise<void> {
    try {
      const releasedInputIsWaitingForRetry = this.ports.pendingInputs
        .listPendingInputs(sessionId)
        .some((item) => item.id === claimedInputId && item.state === 'pending')
      if (
        !releasedInputIsWaitingForRetry &&
        this.ports.pendingInputs.hasPendingTurnInput(sessionId) &&
        (await this.ports.getSessionState(sessionId))?.status === 'idle' &&
        !this.ports.runLifecycle.hasPendingInteractions(sessionId)
      ) {
        this.schedule(sessionId, 'completed')
      }
    } catch (error) {
      this.logDrainError(sessionId, reason, 'cleanup', error)
    }
  }

  private createClaim(
    sessionId: string,
    itemId: string,
    source: PendingInputTurnSource
  ): ClaimedPendingInputHandle {
    return new DurablePendingInputClaim(this.ports.pendingInputs, sessionId, itemId, source)
  }

  private tryRelease(claim: ClaimedPendingInputHandle): boolean {
    if (claim.disposition) {
      return true
    }
    try {
      claim.settle({ kind: 'release-before-user-fact' })
      return true
    } catch (error) {
      console.warn('[DeepChatAgent] failed to release claimed pending input:', error)
      return claim.disposition !== null
    }
  }

  private assertCompletionMatchesClaim(
    itemId: string,
    claim: ClaimedPendingInputHandle,
    completion: TurnCompletion
  ): void {
    const settled = claim.disposition
    const reported = completion.claimedInputDisposition
    if (!settled || !reported || settled.kind !== reported.kind) {
      throw new Error(`Turn completed without settling pending input ${itemId} consistently.`)
    }
  }

  private canDrainFromStatus(
    status: DeepChatSessionState['status'],
    reason: PendingInputWakeReason
  ): boolean {
    return status === 'idle' || (reason === 'enqueue' && status === 'error')
  }

  private logDrainError(
    sessionId: string,
    reason: PendingInputWakeReason,
    stage: string,
    error: unknown
  ): void {
    logger.error(
      `[DeepChatAgent] drainPendingQueueIfPossible error session=${sessionId} reason=${reason} stage=${stage}`,
      redactRuntimeErrorForLog(error)
    )
  }
}
