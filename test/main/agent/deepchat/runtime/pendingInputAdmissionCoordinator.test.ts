import type {
  DeepChatSessionState,
  PendingSessionInputRecord,
  SendMessageInput
} from '@shared/types/agent-interface'
import { describe, expect, it, vi } from 'vitest'
import {
  PendingInputAdmissionCoordinator,
  type PendingInputAdmissionCoordinatorPorts,
  type PendingInputAdmissionPumpPort,
  type PendingInputAdmissionStorePort
} from '@/agent/deepchat/runtime/pendingInputAdmissionCoordinator'
import type {
  ClaimedInputDisposition,
  ClaimedPendingInputHandle
} from '@/agent/deepchat/runtime/pendingInputContracts'

const SESSION_ID = 'session'

function createInput(
  id = 'input',
  mode: PendingSessionInputRecord['mode'] = 'queue'
): PendingSessionInputRecord {
  return {
    id,
    sessionId: SESSION_ID,
    mode,
    state: 'pending',
    payload: { text: 'Promote me', files: [] },
    blocking: null,
    queueOrder: mode === 'queue' ? 1 : null,
    claimedAt: null,
    consumedAt: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function createHarness(onDrain?: (harness: HarnessState) => void) {
  const state: DeepChatSessionState = {
    status: 'idle',
    providerId: 'openai',
    modelId: 'gpt-5',
    permissionMode: 'full_access'
  }
  const harness: HarnessState = {
    activeSteerInputId: undefined,
    draining: false,
    input: createInput()
  }
  const replaceInput = (
    patch: Partial<PendingSessionInputRecord>
  ): PendingSessionInputRecord => {
    if (!harness.input) throw new Error('Pending input not found')
    harness.input = {
      ...harness.input,
      ...patch,
      updatedAt: harness.input.updatedAt + 1
    }
    return harness.input
  }

  let disposition: ClaimedInputDisposition | null = null
  const claim: ClaimedPendingInputHandle = {
    id: 'input',
    source: 'queue',
    get disposition() {
      return disposition
    },
    settle(nextDisposition) {
      if (disposition) throw new Error('Claim already settled')
      disposition = nextDisposition
      switch (nextDisposition.kind) {
        case 'consume':
          replaceInput({ state: 'consumed', consumedAt: 2 })
          return null
        case 'block':
          return replaceInput({
            state: 'blocked',
            claimedAt: null,
            blocking: nextDisposition.attachmentPreparation
          })
        case 'release-before-user-fact':
        case 'release-after-rollback':
          return replaceInput({ state: 'pending', claimedAt: null })
      }
    }
  }

  const pendingInputs: PendingInputAdmissionStorePort = {
    convertPendingInputToSteer: vi.fn((_sessionId, _itemId) =>
      replaceInput({ mode: 'steer', queueOrder: null })
    ),
    degradeBlockedInput: vi.fn(() => replaceInput({ state: 'pending', blocking: null })),
    deletePendingInput: vi.fn(() => {
      harness.input = null
    }),
    getInput: vi.fn((_sessionId, itemId) =>
      harness.input?.id === itemId ? harness.input : null
    ),
    hasActiveInputs: vi.fn(() => harness.input !== null),
    hasBlockingInput: vi.fn(() => harness.input?.state === 'blocked'),
    isAtCapacity: vi.fn(() => false),
    listPendingInputs: vi.fn(() =>
      harness.input && harness.input.state !== 'claimed' && harness.input.state !== 'consumed'
        ? [harness.input]
        : []
    ),
    moveQueuedInput: vi.fn(() => (harness.input ? [harness.input] : [])),
    queuePendingInput: vi.fn((_sessionId, input, options) => {
      harness.input = {
        ...createInput(),
        payload: input,
        state: options?.state ?? 'pending'
      }
      return harness.input
    }),
    queueSteerInput: vi.fn((_sessionId, input) => {
      harness.input = {
        ...createInput('direct-steer', 'steer'),
        payload: input
      }
      return harness.input
    }),
    restoreSteerInputToQueue: vi.fn(() =>
      replaceInput({ mode: 'queue', queueOrder: 1 })
    ),
    retryBlockedInput: vi.fn(() => replaceInput({ state: 'pending', blocking: null })),
    updateQueuedInput: vi.fn((_sessionId, _itemId, input) => replaceInput({ payload: input }))
  }

  const pump: PendingInputAdmissionPumpPort = {
    shouldClaimImmediately: vi.fn(() => false),
    startAcceptedInput: vi.fn(),
    schedule: vi.fn(),
    isAwaitingToolQuestionFollowUp: vi.fn(() => false),
    canDrain: vi.fn(() => true),
    drain: vi.fn(async () => {
      onDrain?.(harness)
      return false
    }),
    claimQueuedInputForPreparation: vi.fn(() => {
      replaceInput({ state: 'claimed', claimedAt: 2 })
      return claim
    })
  }

  const ports: PendingInputAdmissionCoordinatorPorts = {
    providerSettings: {
      getModelConfig: vi.fn(() => undefined)
    },
    pendingInputs,
    pump,
    runLifecycle: {
      cancel: vi.fn(async () => undefined),
      hasPendingInteractions: vi.fn(() => false)
    },
    attachmentRouter: {
      prepare: vi.fn(async ({ content }) => ({
        content,
        summary: { status: 'ready', issues: [], suggestedActions: [] }
      }))
    },
    getSessionState: vi.fn(async () => state),
    getHydratedInstance: vi.fn(() => ({
      clearActiveSteerPendingInputId: (expectedItemId?: string) => {
        if (
          !harness.activeSteerInputId ||
          (expectedItemId && harness.activeSteerInputId !== expectedItemId)
        ) {
          return false
        }
        harness.activeSteerInputId = undefined
        return true
      },
      getAbortController: () => undefined,
      getActiveGeneration: () => undefined,
      getActiveSteerPendingInputId: () => harness.activeSteerInputId,
      isPendingQueueDraining: () => harness.draining,
      setActiveSteerPendingInputId: (itemId: string) => {
        harness.activeSteerInputId = itemId
      }
    })),
    resolveProjectDir: vi.fn(() => null)
  }

  return {
    coordinator: new PendingInputAdmissionCoordinator(ports),
    harness,
    pendingInputs,
    pump
  }
}

interface HarnessState {
  activeSteerInputId: string | undefined
  draining: boolean
  input: PendingSessionInputRecord | null
}

describe('PendingInputAdmissionCoordinator', () => {
  it('keeps a promoted steer when another drain has already claimed it', async () => {
    const test = createHarness((harness) => {
      if (!harness.input) throw new Error('Pending input not found')
      harness.input = {
        ...harness.input,
        state: 'claimed',
        claimedAt: 3
      }
    })

    await expect(test.coordinator.steerPendingInput(SESSION_ID, 'input')).resolves.toMatchObject({
      id: 'input',
      mode: 'steer'
    })

    expect(test.pendingInputs.restoreSteerInputToQueue).not.toHaveBeenCalled()
  })

  it('keeps a promoted steer behind another in-flight drain', async () => {
    const test = createHarness((harness) => {
      harness.draining = true
    })

    await expect(test.coordinator.steerPendingInput(SESSION_ID, 'input')).resolves.toMatchObject({
      id: 'input',
      mode: 'steer'
    })

    expect(test.harness.input).toMatchObject({ mode: 'steer', state: 'pending' })
    expect(test.pendingInputs.restoreSteerInputToQueue).not.toHaveBeenCalled()
  })

  it('accepts a direct steer that completed before its drain result was observed', async () => {
    const test = createHarness((harness) => {
      if (!harness.input) throw new Error('Pending input not found')
      harness.input = {
        ...harness.input,
        state: 'consumed',
        consumedAt: 3
      }
    })

    await expect(
      test.coordinator.steerActiveTurn(SESSION_ID, {
        text: 'Steer now',
        files: []
      } satisfies SendMessageInput)
    ).resolves.toMatchObject({
      requestId: null,
      messageId: null,
      attachmentPreparation: { status: 'ready' }
    })

    expect(test.pendingInputs.deletePendingInput).not.toHaveBeenCalled()
  })

  it('restores a promoted steer when no runtime owner accepted it', async () => {
    const test = createHarness()

    await expect(test.coordinator.steerPendingInput(SESSION_ID, 'input')).rejects.toThrow(
      'Unable to start the steered input.'
    )

    expect(test.pendingInputs.restoreSteerInputToQueue).toHaveBeenCalledWith(SESSION_ID, 'input')
    expect(test.harness.input).toMatchObject({ mode: 'queue', state: 'pending' })
  })
})
