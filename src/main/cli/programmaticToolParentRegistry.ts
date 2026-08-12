import type {
  AgentCliProgrammaticOperationGrant,
  AgentCliProgrammaticOperationBinding,
  AgentCliProgrammaticOperationIdentity,
  AgentCliTokenAuthority,
  ArmedAgentCliProgrammaticToken
} from './agentTokenAuthority'
import {
  ProgrammaticParentOperationError,
  type ProgrammaticChildReservation,
  type ProgrammaticCompletedInvocationResult,
  type ProgrammaticParentSettlementReceipt,
  ProgrammaticToolParentController
} from './programmaticToolParentController'
import { canonicalJsonStringifyData } from '@/tape/domain/canonicalJson'
import type { ExecutionJournalCommitReceipt } from '@/tape/domain/executionJournal'
import type { ToolDispatchCommitInput } from '@shared/types/core/mcp'
import type { PermissionMode } from '@shared/types/agent-interface'
import type {
  ExecutionJournalWriter,
  NestedExecutionJournalWriter
} from '@/tape/ports/capabilities'
import type { ProgrammaticToolCapabilityV1 } from '@/agent/deepchat/runtime/programmaticToolSurface'
import type { ToolSurfaceSnapshot } from '@/agent/deepchat/runtime/toolSurface'

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
  takeCompletedInvocationResult(): ProgrammaticCompletedInvocationResult
  cancelBeforeOuterDispatch(): void
  settleLaunchFailure(input: { responseText: string }): ExecutionJournalCommitReceipt
  settleOuterOutcome(input: {
    responseText: string
    isError: boolean
  }): ExecutionJournalCommitReceipt
}>

export type ProgrammaticToolInvocationAuthority = Readonly<{
  capability: ProgrammaticToolCapabilityV1
  snapshot: ToolSurfaceSnapshot
  permissionMode: PermissionMode
  assertAuthorityActive(): void
}>

export type ProgrammaticToolInvocationContext = Readonly<{
  capability: ProgrammaticToolCapabilityV1
  snapshot: ToolSurfaceSnapshot
  permissionMode: PermissionMode
}>

export type ProgrammaticToolParentRunIdentity = Readonly<{
  sessionId: string
  runId: string
}>

type RegisteredParent = Readonly<{
  key: string
  controller: ProgrammaticToolParentController
  invocationAuthority?: ProgrammaticToolInvocationAuthority
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
    invocationAuthority?: Omit<ProgrammaticToolInvocationAuthority, 'assertAuthorityActive'>
  }): ProgrammaticToolParentRegistration {
    if (!this.options) {
      throw new ProgrammaticParentOperationError(
        'Programmatic parent preparation authority is unavailable',
        'invalid_state'
      )
    }
    const preparedGrant = this.options.tokenAuthority.prepareProgrammaticOperation(input)
    return this.register(
      new ProgrammaticToolParentController(preparedGrant, this.options.executionJournal),
      input.invocationAuthority
        ? {
            ...input.invocationAuthority,
            assertAuthorityActive: input.assertAuthorityActive
          }
        : undefined
    )
  }

  register(
    controller: ProgrammaticToolParentController,
    invocationAuthority?: ProgrammaticToolInvocationAuthority
  ): ProgrammaticToolParentRegistration {
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
    const registered = Object.freeze({ key, controller, invocationAuthority })
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
      takeCompletedInvocationResult: () => {
        requireRegistered()
        return controller.takeCompletedInvocationResult()
      },
      cancelBeforeOuterDispatch: () => {
        requireRegistered()
        controller.cancelBeforeOuterDispatch()
        armedToken = null
        this.parents.delete(key)
      },
      settleLaunchFailure: (input) => {
        requireRegistered()
        const verb = controller.binding.command.verb
        if (verb === 'search' || verb === 'describe') {
          controller.failBeforeDiscoveryResult()
        } else {
          controller.failBeforeChildPlan()
        }
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

  resolveInvocation(grant: AgentCliProgrammaticOperationGrant): ProgrammaticToolInvocationContext {
    const registered = this.resolveRegisteredInvocation(grant)
    const authority = registered?.invocationAuthority
    if (!authority) {
      throw new ProgrammaticParentOperationError(
        'Programmatic invocation authority is unavailable',
        'invalid_state'
      )
    }
    authority.assertAuthorityActive()
    if (
      this.parents.get(registered.key) !== registered ||
      registered.controller.state !== 'armed'
    ) {
      throw new ProgrammaticParentOperationError(
        'Programmatic invocation authority is no longer active',
        'invalid_state'
      )
    }
    return Object.freeze({
      capability: authority.capability,
      snapshot: authority.snapshot,
      permissionMode: authority.permissionMode
    })
  }

  recordDiscoveryResult(
    grant: AgentCliProgrammaticOperationGrant,
    result: ProgrammaticCompletedInvocationResult
  ): void {
    this.resolveRegisteredInvocation(grant).controller.completeDiscoveryInvocation(result)
  }

  failToolInvocationBeforePlan(
    grant: AgentCliProgrammaticOperationGrant,
    result: ProgrammaticCompletedInvocationResult
  ): void {
    const registered = this.resolveRegisteredInvocation(grant)
    registered.controller.failBeforeChildPlan()
    registered.controller.completeToolInvocation(result)
  }

  reserveChildren(
    grant: AgentCliProgrammaticOperationGrant,
    plan: readonly ProgrammaticChildReservation[]
  ): void {
    this.resolveRegisteredInvocation(grant).controller.reserveChildren(plan)
  }

  materializeChild(
    grant: AgentCliProgrammaticOperationGrant,
    input: {
      childOrdinal: number
      argumentTemplate: Readonly<Record<string, unknown>>
      normalizedArguments: Record<string, unknown>
    }
  ): void {
    this.resolveRegisteredInvocation(grant).controller.materializeChild(input)
  }

  commitChildDispatch(
    grant: AgentCliProgrammaticOperationGrant,
    childOrdinal: number,
    input: ToolDispatchCommitInput
  ): ExecutionJournalCommitReceipt {
    return this.resolveRegisteredInvocation(grant).controller.commitChildDispatch(
      childOrdinal,
      input
    )
  }

  commitChildOutcome(
    grant: AgentCliProgrammaticOperationGrant,
    input: { childOrdinal: number; responseText: string; isError: boolean }
  ): ExecutionJournalCommitReceipt {
    return this.resolveRegisteredInvocation(grant).controller.commitChildOutcome(input)
  }

  stopBeforeChild(grant: AgentCliProgrammaticOperationGrant, childOrdinal: number): void {
    this.resolveRegisteredInvocation(grant).controller.stopBeforeChild(childOrdinal)
  }

  recordToolInvocationResult(
    grant: AgentCliProgrammaticOperationGrant,
    result: ProgrammaticCompletedInvocationResult
  ): void {
    this.resolveRegisteredInvocation(grant).controller.completeToolInvocation(result)
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

  private resolveRegisteredInvocation(grant: AgentCliProgrammaticOperationGrant): RegisteredParent {
    const registered = this.parents.get(operationKey(grant.operation))
    const authority = registered?.invocationAuthority
    if (!registered || !authority || registered.controller.state !== 'armed') {
      throw new ProgrammaticParentOperationError(
        'Programmatic parent authority is unavailable',
        'invalid_state'
      )
    }
    const binding = registered.controller.binding
    if (
      canonicalJsonStringifyData({
        schemaVersion: grant.schemaVersion,
        surfaceVersion: grant.surfaceVersion,
        operation: grant.operation,
        command: grant.command,
        route: grant.route,
        canonicalInvocationHash: grant.canonicalInvocationHash,
        adapterMode: grant.adapterMode,
        capabilityHash: grant.capabilityHash,
        programmaticSurfaceHash: grant.programmaticSurfaceHash,
        quotas: grant.quotas
      }) !== canonicalJsonStringifyData(binding) ||
      grant.outerDispatchReceipt.sessionId !== grant.operation.sessionId ||
      grant.outerDispatchReceipt.entryId !== registered.controller.outerDispatchReceiptEntryId ||
      authority.capability.capabilityHash !== grant.capabilityHash ||
      authority.capability.programmaticSurfaceHash !== grant.programmaticSurfaceHash
    ) {
      throw new ProgrammaticParentOperationError(
        'Programmatic invocation does not match its registered parent authority',
        'identity_mismatch'
      )
    }
    return registered
  }
}
