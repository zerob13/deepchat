import type { ProviderModelResolutionPort } from '@/provider/settings'
import type {
  DeepChatSessionState,
  MessageStartResult,
  PendingInputEnqueueSource,
  PendingSessionInputRecord,
  QueuePendingInputOptions,
  SendMessageInput
} from '@shared/types/agent-interface'
import type { DeepChatAgentInstance } from '@/agent/deepchat/instance/deepChatAgentInstance'
import type { SessionPendingInputs } from '@/session/data/pendingInputs'
import type {
  AttachmentCapabilityRouter,
  AttachmentPreparationResult
} from '@/ocr/attachmentCapabilityRouter'
import { awaitWithAbort } from '@/lib/awaitWithAbort'
import { createAbortError } from './abortErrors'
import { supportsProviderVision } from './providerInputCapabilities'
import type { ClaimedPendingInputHandle } from './pendingInputContracts'
import type { PendingInputWakeReason, RunLifecycleCoordinator } from './runLifecycleCoordinator'

export type PendingInputAdmissionStorePort = Pick<
  SessionPendingInputs,
  | 'convertPendingInputToSteer'
  | 'degradeBlockedInput'
  | 'deletePendingInput'
  | 'getInput'
  | 'hasActiveInputs'
  | 'hasBlockingInput'
  | 'isAtCapacity'
  | 'listPendingInputs'
  | 'moveQueuedInput'
  | 'queuePendingInput'
  | 'queueSteerInput'
  | 'restoreSteerInputToQueue'
  | 'retryBlockedInput'
  | 'updateQueuedInput'
>

type PendingInputAdmissionInstancePort = Pick<
  DeepChatAgentInstance,
  | 'clearActiveSteerPendingInputId'
  | 'getAbortController'
  | 'getActiveGeneration'
  | 'getActiveSteerPendingInputId'
  | 'isPendingQueueDraining'
  | 'setActiveSteerPendingInputId'
>

export interface PendingInputAdmissionPumpPort {
  shouldClaimImmediately(
    sessionId: string,
    status: DeepChatSessionState['status'],
    source: PendingInputEnqueueSource
  ): boolean
  startAcceptedInput(
    record: PendingSessionInputRecord,
    source: PendingInputEnqueueSource,
    projectDir: string | null
  ): void
  schedule(sessionId: string, reason: PendingInputWakeReason): void
  isAwaitingToolQuestionFollowUp(sessionId: string): boolean
  canDrain(
    sessionId: string,
    status: DeepChatSessionState['status'],
    reason: PendingInputWakeReason
  ): boolean
  drain(sessionId: string, reason: PendingInputWakeReason): Promise<boolean>
  claimQueuedInputForPreparation(
    sessionId: string,
    itemId: string
  ): ClaimedPendingInputHandle
}

type PendingInputAdmissionLifecyclePort = Pick<
  RunLifecycleCoordinator,
  'cancel' | 'hasPendingInteractions'
>

export interface PendingInputAdmissionCoordinatorPorts {
  providerSettings: Pick<ProviderModelResolutionPort, 'getModelConfig'>
  pendingInputs: PendingInputAdmissionStorePort
  pump: PendingInputAdmissionPumpPort
  runLifecycle: PendingInputAdmissionLifecyclePort
  attachmentRouter: Pick<AttachmentCapabilityRouter, 'prepare'>
  getSessionState(sessionId: string): Promise<DeepChatSessionState | null>
  getHydratedInstance(sessionId: string): PendingInputAdmissionInstancePort | undefined
  resolveProjectDir(sessionId: string, projectDir?: string | null): string | null
}

export class PendingInputAdmissionCoordinator {
  private readonly attachmentAcceptanceTails = new Map<string, Promise<void>>()

  constructor(private readonly ports: PendingInputAdmissionCoordinatorPorts) {}

  list(sessionId: string): PendingSessionInputRecord[] {
    return this.ports.pendingInputs.listPendingInputs(sessionId)
  }

  async queue(
    sessionId: string,
    content: string | SendMessageInput,
    options?: QueuePendingInputOptions
  ): Promise<PendingSessionInputRecord> {
    const state = await this.ports.getSessionState(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }
    const projectDir =
      options && Object.prototype.hasOwnProperty.call(options, 'projectDir')
        ? this.ports.resolveProjectDir(sessionId, options.projectDir)
        : this.ports.resolveProjectDir(sessionId)
    const input = typeof content === 'string' ? { text: content, files: [] } : content
    if (options?.signal?.aborted) throw createAbortError()
    if (!input.text.trim() && (input.files?.length ?? 0) === 0) {
      throw new Error('Message cannot be empty.')
    }

    const source = options?.source ?? 'send'
    const shouldClaimImmediately = this.ports.pump.shouldClaimImmediately(
      sessionId,
      state.status,
      source
    )
    const record = this.ports.pendingInputs.queuePendingInput(sessionId, input, {
      state: shouldClaimImmediately ? 'claimed' : 'pending'
    })

    if (record.state === 'claimed') {
      this.ports.pump.startAcceptedInput(record, source, projectDir)
    } else {
      this.ports.pump.schedule(sessionId, 'enqueue')
    }
    return record
  }

  async sendQueuedMessage(
    sessionId: string,
    content: SendMessageInput,
    options: QueuePendingInputOptions,
    context?: { signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    if ((options.source ?? 'send') !== 'send') {
      await this.queue(sessionId, content, {
        ...options,
        signal: context?.signal
      })
      return { requestId: null, messageId: null }
    }

    const releaseAcceptanceLane = await this.acquireAttachmentAcceptanceLane(
      sessionId,
      'send',
      context?.signal
    )
    try {
      if (this.ports.pendingInputs.isAtCapacity(sessionId)) {
        throw new Error('Pending input limit reached for this session.')
      }

      const prepared = await this.prepareMessageInputNow(sessionId, content, {
        signal: context?.signal
      })
      if (prepared.summary.status === 'needs_user_action') {
        return {
          requestId: null,
          messageId: null,
          attachmentPreparation: prepared.summary
        }
      }

      if (context?.signal?.aborted) throw createAbortError()

      await this.queue(sessionId, prepared.content, {
        ...options,
        signal: context?.signal
      })
      return {
        requestId: null,
        messageId: null,
        attachmentPreparation: prepared.summary
      }
    } finally {
      releaseAcceptanceLane()
    }
  }

  async steerActiveTurn(
    sessionId: string,
    content: string | SendMessageInput,
    options?: { signal?: AbortSignal }
  ): Promise<MessageStartResult> {
    const input = typeof content === 'string' ? { text: content, files: [] } : content
    const hasPriorSteerAcceptance = this.attachmentAcceptanceTails.has(`steer:${sessionId}`)
    const releaseAcceptanceLane =
      input.files?.length || hasPriorSteerAcceptance
        ? await this.acquireAttachmentAcceptanceLane(sessionId, 'steer', options?.signal)
        : () => {}
    try {
      const state = await this.ports.getSessionState(sessionId)
      if (!state) {
        throw new Error(`Session ${sessionId} not found`)
      }
      if (
        this.ports.pump.isAwaitingToolQuestionFollowUp(sessionId) ||
        this.ports.runLifecycle.hasPendingInteractions(sessionId)
      ) {
        throw new Error('Please resolve pending tool interactions before steering.')
      }
      if (!input.text.trim() && (input.files?.length ?? 0) === 0) {
        return { requestId: null, messageId: null }
      }

      const prepared: AttachmentPreparationResult = input.files?.length
        ? await this.prepareMessageInputNow(sessionId, input, { signal: options?.signal })
        : {
            content: input,
            summary: { status: 'ready', issues: [], suggestedActions: [] }
          }
      if (prepared.summary.status === 'needs_user_action') {
        return {
          requestId: null,
          messageId: null,
          attachmentPreparation: prepared.summary
        }
      }
      if (options?.signal?.aborted) throw createAbortError()
      const preparedResult: MessageStartResult = {
        requestId: null,
        messageId: null,
        attachmentPreparation: prepared.summary
      }

      if (this.ports.pendingInputs.hasBlockingInput(sessionId)) {
        this.queueVisibleSteerInput(sessionId, prepared.content)
        return preparedResult
      }

      const instance = this.ports.getHydratedInstance(sessionId)
      const activeGeneration = instance?.getActiveGeneration()
      const preStreamController = instance?.getAbortController()

      if (activeGeneration) {
        this.queueVisibleSteerInput(sessionId, prepared.content)
        releaseAcceptanceLane()
        await this.ports.runLifecycle.cancel(sessionId)
        return preparedResult
      }

      if (preStreamController) {
        this.queueVisibleSteerInput(sessionId, prepared.content)
        return preparedResult
      }

      if (!this.ports.pump.canDrain(sessionId, state.status, 'enqueue')) {
        if (instance?.isPendingQueueDraining() || state.status === 'generating') {
          this.queueVisibleSteerInput(sessionId, prepared.content)
          return preparedResult
        }
        throw new Error('Unable to start the steered input.')
      }

      const record = this.queueVisibleSteerInput(sessionId, prepared.content)
      releaseAcceptanceLane()
      const started = await this.ports.pump.drain(sessionId, 'enqueue')
      if (started) {
        return preparedResult
      }

      if (await this.isAcceptedInputOwned(sessionId, record.id)) {
        return preparedResult
      }

      try {
        this.ports.pendingInputs.deletePendingInput(sessionId, record.id)
        instance?.clearActiveSteerPendingInputId(record.id)
      } catch (deleteError) {
        console.error('[AgentRuntime] Failed to delete unstarted steer input:', deleteError)
      }
      throw new Error('Unable to start the steered input.')
    } finally {
      releaseAcceptanceLane()
    }
  }

  async updateQueuedInput(
    sessionId: string,
    itemId: string,
    content: string | SendMessageInput
  ): Promise<PendingSessionInputRecord> {
    await this.ensureSessionReady(sessionId)
    const input = typeof content === 'string' ? { text: content, files: [] } : content
    if (!input.text.trim() && (input.files?.length ?? 0) === 0) {
      throw new Error('Message cannot be empty.')
    }
    const record = this.ports.pendingInputs.updateQueuedInput(sessionId, itemId, input)
    this.ports.pump.schedule(sessionId, 'enqueue')
    return record
  }

  async moveQueuedInput(
    sessionId: string,
    itemId: string,
    toIndex: number
  ): Promise<PendingSessionInputRecord[]> {
    await this.ensureSessionReady(sessionId)
    return this.ports.pendingInputs.moveQueuedInput(sessionId, itemId, toIndex)
  }

  async convertPendingInputToSteer(
    sessionId: string,
    itemId: string
  ): Promise<PendingSessionInputRecord> {
    await this.ensureSessionReady(sessionId)
    return this.ports.pendingInputs.convertPendingInputToSteer(sessionId, itemId)
  }

  async steerPendingInput(sessionId: string, itemId: string): Promise<PendingSessionInputRecord> {
    const releaseAcceptanceLane = await this.acquireAttachmentAcceptanceLane(sessionId, 'steer')
    try {
      await this.ensureSessionReady(sessionId)
      if (
        this.ports.pump.isAwaitingToolQuestionFollowUp(sessionId) ||
        this.ports.runLifecycle.hasPendingInteractions(sessionId)
      ) {
        throw new Error('Please resolve pending tool interactions before steering.')
      }

      const pendingInput = this.ports.pendingInputs
        .listPendingInputs(sessionId)
        .find((item) => item.id === itemId)
      if (!pendingInput) {
        throw new Error(`Pending input not found: ${itemId}`)
      }
      if (pendingInput.mode !== 'queue' || pendingInput.state !== 'pending') {
        throw new Error('Only a pending queue input can be steered.')
      }
      if (this.ports.pendingInputs.hasBlockingInput(sessionId)) {
        throw new Error('Resolve the blocked attachment input before steering another item.')
      }

      const claim = this.ports.pump.claimQueuedInputForPreparation(sessionId, itemId)
      let prepared: AttachmentPreparationResult
      try {
        prepared = await this.prepareMessageInputNow(sessionId, pendingInput.payload)
      } catch (error) {
        claim.settle({ kind: 'release-before-user-fact' })
        throw error
      }
      if (prepared.summary.status === 'needs_user_action') {
        try {
          const blocked = claim.settle({
            kind: 'block',
            attachmentPreparation: prepared.summary
          })
          if (!blocked) {
            throw new Error(`Failed to block pending input ${itemId}`)
          }
          return blocked
        } catch (error) {
          if (!claim.disposition) {
            claim.settle({ kind: 'release-before-user-fact' })
          }
          throw error
        }
      }

      claim.settle({ kind: 'release-before-user-fact' })
      this.ports.pendingInputs.updateQueuedInput(sessionId, itemId, prepared.content)
      const record = this.ports.pendingInputs.convertPendingInputToSteer(sessionId, itemId)

      const instance = this.ports.getHydratedInstance(sessionId)
      const activeGeneration = instance?.getActiveGeneration()
      const preStreamController = instance?.getAbortController()

      if (activeGeneration) {
        releaseAcceptanceLane()
        await this.ports.runLifecycle.cancel(sessionId)
        return record
      }

      if (preStreamController) {
        return record
      }

      releaseAcceptanceLane()
      const started = await this.ports.pump.drain(sessionId, 'enqueue')
      if (!started) {
        if (await this.isAcceptedInputOwned(sessionId, itemId)) {
          return record
        }
        try {
          this.ports.pendingInputs.restoreSteerInputToQueue(sessionId, itemId)
        } catch (restoreError) {
          console.error('[AgentRuntime] Failed to restore steered input to queue:', restoreError)
        }
        throw new Error('Unable to start the steered input.')
      }
      return record
    } finally {
      releaseAcceptanceLane()
    }
  }

  async deletePendingInput(sessionId: string, itemId: string): Promise<void> {
    await this.ensureSessionReady(sessionId)
    this.ports.pendingInputs.deletePendingInput(sessionId, itemId)
    this.ports.pump.schedule(sessionId, 'enqueue')
  }

  async resolveBlockedPendingInput(
    sessionId: string,
    itemId: string,
    action: 'retry' | 'send_without_image_content'
  ): Promise<PendingSessionInputRecord> {
    await this.ensureSessionReady(sessionId)
    const record =
      action === 'retry'
        ? this.ports.pendingInputs.retryBlockedInput(sessionId, itemId)
        : this.ports.pendingInputs.degradeBlockedInput(sessionId, itemId)
    this.ports.pump.schedule(sessionId, 'enqueue')
    return record
  }

  assertNoActiveInputs(sessionId: string): void {
    if (!this.ports.pendingInputs.hasActiveInputs(sessionId)) {
      return
    }
    throw new Error('Please clear the waiting lane before mutating chat history.')
  }

  private async acquireAttachmentAcceptanceLane(
    sessionId: string,
    lane: 'send' | 'steer',
    signal?: AbortSignal
  ): Promise<() => void> {
    const key = `${lane}:${sessionId}`
    const previous = this.attachmentAcceptanceTails.get(key) ?? Promise.resolve()
    let resolveSlot!: () => void
    const slot = new Promise<void>((resolve) => {
      resolveSlot = resolve
    })
    const tail = previous.then(
      () => slot,
      () => slot
    )
    this.attachmentAcceptanceTails.set(key, tail)

    let released = false
    const release = () => {
      if (released) return
      released = true
      resolveSlot()
      void tail.then(() => {
        if (this.attachmentAcceptanceTails.get(key) === tail) {
          this.attachmentAcceptanceTails.delete(key)
        }
      })
    }
    try {
      await awaitWithAbort(previous, signal)
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  private async prepareMessageInputNow(
    sessionId: string,
    content: SendMessageInput,
    options?: {
      preserveResolvedRepresentations?: boolean
      signal?: AbortSignal
    }
  ): Promise<AttachmentPreparationResult> {
    const state = await this.ports.getSessionState(sessionId)
    if (!state) throw new Error(`Session ${sessionId} not found`)
    return await this.ports.attachmentRouter.prepare({
      content,
      supportsVision: supportsProviderVision(
        this.ports.providerSettings,
        state.providerId,
        state.modelId
      ),
      signal: options?.signal,
      preserveResolvedRepresentations: options?.preserveResolvedRepresentations,
      emitDiagnostics: false
    })
  }

  private async ensureSessionReady(sessionId: string): Promise<void> {
    const state = await this.ports.getSessionState(sessionId)
    if (!state) {
      throw new Error(`Session ${sessionId} not found`)
    }
  }

  private async isAcceptedInputOwned(sessionId: string, itemId: string): Promise<boolean> {
    const input = this.ports.pendingInputs.getInput(sessionId, itemId)
    if (!input || input.mode !== 'steer') {
      return false
    }
    if (input.state !== 'pending') {
      return true
    }

    const instance = this.ports.getHydratedInstance(sessionId)
    if (
      instance?.isPendingQueueDraining() ||
      instance?.getActiveGeneration() ||
      instance?.getAbortController()
    ) {
      return true
    }

    return (await this.ports.getSessionState(sessionId))?.status === 'generating'
  }

  private queueVisibleSteerInput(
    sessionId: string,
    input: SendMessageInput
  ): PendingSessionInputRecord {
    const instance = this.ports.getHydratedInstance(sessionId)
    if (!instance) {
      throw new Error(`Session ${sessionId} not found`)
    }
    const mergeItemId = instance.getActiveSteerPendingInputId() ?? null
    try {
      const record = this.ports.pendingInputs.queueSteerInput(sessionId, input, {
        mergeItemId
      })
      instance.setActiveSteerPendingInputId(record.id)
      return record
    } catch (error) {
      if (!mergeItemId) {
        throw error
      }
      instance.clearActiveSteerPendingInputId()
      const record = this.ports.pendingInputs.queueSteerInput(sessionId, input)
      instance.setActiveSteerPendingInputId(record.id)
      return record
    }
  }
}
