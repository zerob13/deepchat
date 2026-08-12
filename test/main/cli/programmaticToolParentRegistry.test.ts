import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_CLI_PROGRAMMATIC_GRANT_SCHEMA_VERSION,
  AgentCliTokenAuthority,
  type AgentCliProgrammaticOperationBinding
} from '@/cli/agentTokenAuthority'
import { ProgrammaticToolParentController } from '@/cli/programmaticToolParentController'
import { ProgrammaticToolParentRegistry } from '@/cli/programmaticToolParentRegistry'
import { LOCAL_CONTROL_PROGRAMMATIC_ROUTE_SURFACE_VERSION } from '@shared/contracts/localControl'
import { ExecutionJournalService } from '@/tape/application/executionJournalService'
import { createTapeTableMock } from '../session/data/tapeTestHarness'

const RUN_ID = '22222222-2222-4222-8222-222222222222'
const RUN = { sessionId: 'session-1', runId: RUN_ID }

function binding(): AgentCliProgrammaticOperationBinding {
  return {
    schemaVersion: AGENT_CLI_PROGRAMMATIC_GRANT_SCHEMA_VERSION,
    surfaceVersion: LOCAL_CONTROL_PROGRAMMATIC_ROUTE_SURFACE_VERSION,
    operation: {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      runId: RUN_ID,
      requestSeq: 1,
      providerToolCallId: 'exec-call-1'
    },
    command: { domain: 'tool', verb: 'call' },
    route: 'tool.call',
    canonicalInvocationHash: '1'.repeat(64),
    adapterMode: 'cli-programmatic',
    capabilityHash: '2'.repeat(64),
    programmaticSurfaceHash: '3'.repeat(64),
    quotas: {
      maxChildren: 4,
      maxBatchSteps: 4,
      maxInputBytes: 4_096,
      maxOutputBytes: 8_192,
      maxDurationMs: 30_000
    }
  }
}

function setup() {
  const operationBinding = binding()
  const { table } = createTapeTableMock()
  const journal = new ExecutionJournalService(() => table)
  const authority = new AgentCliTokenAuthority({
    createToken: () => 'p'.repeat(43),
    createTokenId: () => 'programmatic-token-1'
  })
  const prepared = authority.prepareProgrammaticOperation({
    binding: operationBinding,
    assertAuthorityActive: () => undefined
  })
  const controller = new ProgrammaticToolParentController(prepared, journal)
  const registry = new ProgrammaticToolParentRegistry()
  const registration = registry.register(controller)
  journal.commitRunStarted({
    sessionId: operationBinding.operation.sessionId,
    runId: operationBinding.operation.runId,
    messageId: operationBinding.operation.messageId,
    runKind: 'loop'
  })
  return { authority, controller, journal, operationBinding, registration, registry }
}

describe('ProgrammaticToolParentRegistry', () => {
  it('prepares an inert grant and exposes it exactly once after the real outer T1', () => {
    const operationBinding = binding()
    const { table } = createTapeTableMock()
    const journal = new ExecutionJournalService(() => table)
    const authority = new AgentCliTokenAuthority({
      createToken: () => 'r'.repeat(43),
      createTokenId: () => 'prepared-programmatic-token'
    })
    const registry = new ProgrammaticToolParentRegistry({
      tokenAuthority: authority,
      executionJournal: journal
    })
    journal.commitRunStarted({
      sessionId: operationBinding.operation.sessionId,
      runId: operationBinding.operation.runId,
      messageId: operationBinding.operation.messageId,
      runKind: 'loop'
    })
    const registration = registry.prepare({
      binding: operationBinding,
      assertAuthorityActive: () => undefined
    })

    expect(authority.beginRequest('r'.repeat(43))).toEqual({ status: 'invalid' })
    expect(() => registration.takeArmedToken()).toThrow(/no armed invocation token/)
    const outerDispatch = journal.commitDispatch({
      sessionId: operationBinding.operation.sessionId,
      messageId: operationBinding.operation.messageId,
      operation: {
        runId: operationBinding.operation.runId,
        requestSeq: operationBinding.operation.requestSeq,
        providerToolCallId: operationBinding.operation.providerToolCallId
      },
      toolName: 'exec',
      toolSource: 'agent',
      normalizedArguments: { command: 'deepchat tool call', stdin: '{}' },
      target: { serverName: 'agent-filesystem', originalName: 'exec' }
    })
    registration.armOuterDispatch({
      ...outerDispatch,
      operation: operationBinding.operation
    })

    const armed = registration.takeArmedToken()
    expect(armed.token).toBe('r'.repeat(43))
    expect(() => registration.takeArmedToken()).toThrow(/no armed invocation token/)
    expect(
      registration.settleLaunchFailure({ responseText: 'launcher unavailable' })
    ).toMatchObject({ created: true })
    expect(authority.beginRequest(armed.token)).toEqual({ status: 'invalid' })
    expect(() => registry.assertRunTerminalAllowed(RUN)).not.toThrow()
  })

  it('settles a known launch error when live View authority is revoked after outer T1', () => {
    const operationBinding = binding()
    const { table } = createTapeTableMock()
    const journal = new ExecutionJournalService(() => table)
    const authority = new AgentCliTokenAuthority({
      createToken: () => 's'.repeat(43),
      createTokenId: () => 'revoked-programmatic-token'
    })
    const registry = new ProgrammaticToolParentRegistry({
      tokenAuthority: authority,
      executionJournal: journal
    })
    let active = true
    journal.commitRunStarted({
      sessionId: operationBinding.operation.sessionId,
      runId: operationBinding.operation.runId,
      messageId: operationBinding.operation.messageId,
      runKind: 'loop'
    })
    const registration = registry.prepare({
      binding: operationBinding,
      assertAuthorityActive: () => {
        if (!active) throw new Error('View revoked')
      }
    })
    const outerDispatch = journal.commitDispatch({
      sessionId: operationBinding.operation.sessionId,
      messageId: operationBinding.operation.messageId,
      operation: {
        runId: operationBinding.operation.runId,
        requestSeq: operationBinding.operation.requestSeq,
        providerToolCallId: operationBinding.operation.providerToolCallId
      },
      toolName: 'exec',
      toolSource: 'agent',
      normalizedArguments: { command: 'deepchat tool call', stdin: '{}' },
      target: { serverName: 'agent-filesystem', originalName: 'exec' }
    })
    active = false

    expect(() =>
      registration.armOuterDispatch({
        ...outerDispatch,
        operation: operationBinding.operation
      })
    ).toThrow('View revoked')
    expect(authority.snapshot()).toEqual({ tokens: 0, conversations: 0 })
    expect(registration.settleLaunchFailure({ responseText: 'View revoked' })).toMatchObject({
      created: true
    })
    expect(() => registry.assertRunTerminalAllowed(RUN)).not.toThrow()
  })

  it('blocks Run terminal before outer settlement and does not invoke its writer', () => {
    const { registry } = setup()
    const commit = vi.fn(() => ({ sessionId: RUN.sessionId, entryId: 99, created: true }))

    expect(() => registry.commitRunTerminal(RUN, commit)).toThrow(
      /has not settled its outer outcome/
    )
    expect(commit).not.toHaveBeenCalled()
  })

  it('arms from the real outer T1 receipt and settles outer T2 before Run terminal', () => {
    const { authority, controller, journal, operationBinding, registration, registry } = setup()
    const outerDispatch = journal.commitDispatch({
      sessionId: operationBinding.operation.sessionId,
      messageId: operationBinding.operation.messageId,
      operation: {
        runId: operationBinding.operation.runId,
        requestSeq: operationBinding.operation.requestSeq,
        providerToolCallId: operationBinding.operation.providerToolCallId
      },
      toolName: 'exec',
      toolSource: 'agent',
      normalizedArguments: { command: 'deepchat tool call' },
      target: { serverName: 'agent-filesystem', originalName: 'exec' }
    })
    registration.armOuterDispatch({
      ...outerDispatch,
      operation: operationBinding.operation
    })
    const armed = registration.takeArmedToken()
    controller.failBeforeChildPlan()
    expect(authority.beginRequest(armed.token)).toEqual({ status: 'invalid' })
    expect(
      registration.settleOuterOutcome({ responseText: 'request rejected', isError: true })
    ).toMatchObject({ created: true })

    const terminalReceipt = { sessionId: 'session-1', entryId: 99, created: true }
    const commit = vi.fn(() => terminalReceipt)
    expect(registry.commitRunTerminal(RUN, commit)).toEqual(terminalReceipt)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('keeps a settled registration fenced when terminal persistence fails', () => {
    const { controller, journal, operationBinding, registration, registry } = setup()
    const outerDispatch = journal.commitDispatch({
      sessionId: operationBinding.operation.sessionId,
      messageId: operationBinding.operation.messageId,
      operation: {
        runId: operationBinding.operation.runId,
        requestSeq: operationBinding.operation.requestSeq,
        providerToolCallId: operationBinding.operation.providerToolCallId
      },
      toolName: 'exec',
      toolSource: 'agent',
      normalizedArguments: { command: 'deepchat tool call' },
      target: { serverName: 'agent-filesystem', originalName: 'exec' }
    })
    registration.armOuterDispatch({ ...outerDispatch, operation: operationBinding.operation })
    controller.failBeforeChildPlan()
    registration.settleOuterOutcome({ responseText: 'request rejected', isError: true })

    expect(() =>
      registry.commitRunTerminal(RUN, () => {
        throw new Error('disk full')
      })
    ).toThrow('disk full')
    expect(() => registry.assertRunTerminalAllowed(RUN)).not.toThrow()
    expect(() =>
      registration.settleOuterOutcome({ responseText: 'request rejected', isError: true })
    ).toThrow(/settled, expected armed/)
  })

  it('rejects duplicate process-live registrations for one provider operation', () => {
    const { controller, registry } = setup()
    expect(() => registry.register(controller)).toThrow(/already registered/)
  })

  it('retains settled registrations when terminal persistence reports an existing fact', () => {
    const { controller, journal, operationBinding, registration, registry } = setup()
    const outerDispatch = journal.commitDispatch({
      sessionId: operationBinding.operation.sessionId,
      messageId: operationBinding.operation.messageId,
      operation: {
        runId: operationBinding.operation.runId,
        requestSeq: operationBinding.operation.requestSeq,
        providerToolCallId: operationBinding.operation.providerToolCallId
      },
      toolName: 'exec',
      toolSource: 'agent',
      normalizedArguments: { command: 'deepchat tool call' },
      target: { serverName: 'agent-filesystem', originalName: 'exec' }
    })
    registration.armOuterDispatch({ ...outerDispatch, operation: operationBinding.operation })
    controller.failBeforeChildPlan()
    registration.settleOuterOutcome({ responseText: 'request rejected', isError: true })

    expect(
      registry.commitRunTerminal(RUN, () => ({
        sessionId: RUN.sessionId,
        entryId: 100,
        created: false
      }))
    ).toMatchObject({ created: false })
    expect(() => registry.assertRunTerminalAllowed(RUN)).not.toThrow()
    expect(() =>
      registration.settleOuterOutcome({ responseText: 'request rejected', isError: true })
    ).toThrow(/settled, expected armed/)
  })

  it('revokes a conflicting prepared grant for the same provider operation', () => {
    const { journal, operationBinding, registry } = setup()
    const authority = new AgentCliTokenAuthority({
      createToken: () => 'q'.repeat(43),
      createTokenId: () => 'conflicting-programmatic-token'
    })
    const prepared = authority.prepareProgrammaticOperation({
      binding: { ...operationBinding, capabilityHash: '4'.repeat(64) },
      assertAuthorityActive: () => undefined
    })
    const conflicting = new ProgrammaticToolParentController(prepared, journal)

    expect(() => registry.register(conflicting)).toThrow(/already registered/)
    expect(conflicting.state).toBe('revoked')
    expect(authority.snapshot()).toEqual({ tokens: 0, conversations: 0 })
  })
})
