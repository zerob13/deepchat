import type {
  AgentCliProgrammaticOperationBinding,
  AgentCliProgrammaticOperationIdentity,
  AgentCliTokenAuthority,
  ArmedAgentCliProgrammaticToken
} from './agentTokenAuthority'
import {
  ProgrammaticParentOperationError,
  type ProgrammaticParentSettlementReceipt,
  ProgrammaticToolParentController
} from './programmaticToolParentController'
import { canonicalJsonStringifyData } from '@/tape/domain/canonicalJson'
import type { ExecutionJournalCommitReceipt } from '@/tape/domain/executionJournal'
import type {
  ExecutionJournalWriter,
  NestedExecutionJournalWriter
} from '@/tape/ports/capabilities'

type ProgrammaticParentExecutionJournal = Pick<ExecutionJournalWriter, 'commitToolOutcome'> &
  NestedExecutionJournalWriter

export type ProgrammaticToolParentRegistryOptions = Readonly<{
  tokenAuthority: Pick<AgentCliTokenAuthority, 'prepareProgrammaticOperation'>
  executionJournal: ProgrammaticParentExecutionJournal
}>

export type ProgrammaticToolParentRegistration = Readonly<{
  operation: AgentCliProgrammaticOperationIdentity
  armOuterDispatch(
    receipt: ExecutionJournalCommitReceipt & { operation: AgentCliProgrammaticOperationIdentity }
  ): void
  takeArmedToken(): ArmedAgentCliProgrammaticToken
  cancelBeforeOuterDispatch(): void
  settleLaunchFailure(input: { responseText: string }): ExecutionJournalCommitReceipt
  settleOuterOutcome(input: {
    responseText: string
    isError: boolean
  }): ExecutionJournalCommitReceipt
}>

export type ProgrammaticToolParentRunIdentity = Readonly<{
  sessionId: string
  runId: string
}>

type RegisteredParent = Readonly<{
  key: string
  controller: ProgrammaticToolParentController
}>

function operationKey(operation: AgentCliProgrammaticOperationIdentity): string {
  return canonicalJsonStringifyData(operation)
}

/**
 * Process-live owner for Programmatic parent operations. It is a causality fence, not durable
 * authority: dispatch and recovery must never reconstruct registrations by reading Tape.
 */
export class ProgrammaticToolParentRegistry {
  private readonly parents = new Map<string, RegisteredParent>()

  constructor(private readonly options?: ProgrammaticToolParentRegistryOptions) {}

  prepare(input: {
    binding: AgentCliProgrammaticOperationBinding
    assertAuthorityActive: () => void
  }): ProgrammaticToolParentRegistration {
    if (!this.options) {
      throw new ProgrammaticParentOperationError(
        'Programmatic parent preparation authority is unavailable',
        'invalid_state'
      )
    }
    const preparedGrant = this.options.tokenAuthority.prepareProgrammaticOperation(input)
    return this.register(
      new ProgrammaticToolParentController(preparedGrant, this.options.executionJournal)
    )
  }

  register(controller: ProgrammaticToolParentController): ProgrammaticToolParentRegistration {
    if (controller.state !== 'prepared') {
      throw new ProgrammaticParentOperationError(
        'Programmatic parent must be prepared before registration',
        'invalid_state'
      )
    }
    const operation = controller.operation
    const key = operationKey(operation)
    const existing = this.parents.get(key)
    if (existing) {
      if (existing.controller !== controller) controller.cancelBeforeOuterDispatch()
      throw new ProgrammaticParentOperationError(
        'Programmatic parent operation is already registered',
        'identity_mismatch'
      )
    }
    const registered = Object.freeze({ key, controller })
    this.parents.set(key, registered)
    let armedToken: ArmedAgentCliProgrammaticToken | null = null

    const requireRegistered = (): void => {
      if (this.parents.get(key) !== registered) {
        throw new ProgrammaticParentOperationError(
          'Programmatic parent registration is no longer active',
          'invalid_state'
        )
      }
    }

    return Object.freeze({
      operation,
      armOuterDispatch: (receipt) => {
        requireRegistered()
        if (armedToken) {
          throw new ProgrammaticParentOperationError(
            'Programmatic parent grant was already armed',
            'invalid_state'
          )
        }
        armedToken = controller.armOuterDispatch(receipt)
      },
      takeArmedToken: () => {
        requireRegistered()
        if (!armedToken) {
          throw new ProgrammaticParentOperationError(
            'Programmatic parent has no armed invocation token',
            'invalid_state'
          )
        }
        const token = armedToken
        armedToken = null
        return token
      },
      cancelBeforeOuterDispatch: () => {
        requireRegistered()
        controller.cancelBeforeOuterDispatch()
        armedToken = null
        this.parents.delete(key)
      },
      settleLaunchFailure: (input) => {
        requireRegistered()
        controller.failBeforeChildPlan()
        armedToken = null
        const settlement = controller.issueSettlementReceipt({
          responseText: input.responseText,
          isError: true
        })
        return controller.commitOuterOutcome(settlement, {
          responseText: input.responseText,
          isError: true
        })
      },
      settleOuterOutcome: (input) => {
        requireRegistered()
        armedToken = null
        const settlement: ProgrammaticParentSettlementReceipt =
          controller.issueSettlementReceipt(input)
        return controller.commitOuterOutcome(settlement, input)
      }
    })
  }

  assertRunTerminalAllowed(run: ProgrammaticToolParentRunIdentity): void {
    for (const { controller } of this.parents.values()) {
      if (
        controller.operation.sessionId === run.sessionId &&
        controller.operation.runId === run.runId
      ) {
        controller.assertRunTerminalAllowed()
      }
    }
  }

  commitRunTerminal(
    run: ProgrammaticToolParentRunIdentity,
    commit: () => ExecutionJournalCommitReceipt
  ): ExecutionJournalCommitReceipt {
    this.assertRunTerminalAllowed(run)
    const result = commit()
    if (result.sessionId !== run.sessionId) {
      throw new ProgrammaticParentOperationError(
        'Programmatic Run terminal receipt has a conflicting session identity',
        'identity_mismatch'
      )
    }
    if (!result.created) return result
    for (const [key, { controller }] of this.parents) {
      if (
        controller.operation.sessionId === run.sessionId &&
        controller.operation.runId === run.runId
      ) {
        this.parents.delete(key)
      }
    }
    return result
  }
}
