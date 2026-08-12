import { describe, expect, it, vi } from 'vitest'
import { TOOL_EXECUTION, type MCPToolDefinition } from '@shared/types/core/mcp'
import {
  LOCAL_CONTROL_PROGRAMMATIC_ROUTE_SURFACE_VERSION,
  type LocalControlErrorCode
} from '@shared/contracts/localControl'
import {
  toolBatchRoute,
  toolCallRoute,
  toolDescribeRoute,
  toolSearchRoute
} from '@shared/contracts/routes/tools.routes'
import {
  buildProgrammaticToolCapabilityV1,
  createProgrammaticToolSurfaceRunControllerV1,
  type ProgrammaticToolCapabilityV1
} from '@/agent/deepchat/runtime/programmaticToolSurface'
import type { ToolSurfaceSnapshot } from '@/agent/deepchat/runtime/toolSurface'
import {
  AGENT_CLI_PROGRAMMATIC_GRANT_SCHEMA_VERSION,
  type AgentCliProgrammaticOperationGrant,
  type AgentCliProgrammaticToolVerb
} from '@/cli/agentTokenAuthority'
import { CliRequestError } from '@/cli/errors'
import { ProgrammaticToolDispatcher } from '@/cli/programmaticToolDispatcher'
import type { CliRouteCaller } from '@/routes/routeRegistry'

const SERVER_ID = '22222222-2222-4222-8222-222222222222'
const BINDING_HASH = 'a'.repeat(64)

function agentExec(): MCPToolDefinition {
  return {
    source: 'agent',
    execution: TOOL_EXECUTION.write,
    type: 'function',
    function: {
      name: 'exec',
      description: 'Execute an approved command',
      parameters: { type: 'object', properties: {} }
    },
    server: {
      name: 'agent-filesystem',
      icons: '',
      description: 'Agent filesystem tools'
    }
  }
}

function mcpTool(input: {
  name: string
  description?: string
  effect?: 'read' | 'write'
  properties?: Record<string, unknown>
  required?: string[]
  rawMeta?: Record<string, unknown>
}): MCPToolDefinition {
  const properties = input.properties ?? { query: { type: 'string' } }
  return {
    source: 'mcp',
    execution: input.effect === 'write' ? TOOL_EXECUTION.write : TOOL_EXECUTION.read.parallel,
    type: 'function',
    function: {
      name: input.name,
      description: input.description ?? `${input.name} calendar operations`,
      parameters: {
        type: 'object',
        properties,
        ...(input.required ? { required: input.required } : {})
      }
    },
    server: {
      id: SERVER_ID,
      name: 'remote',
      icons: '',
      description: 'Remote MCP tools',
      configGeneration: 1,
      bindingHash: BINDING_HASH
    },
    raw: {
      name: input.name,
      inputSchema: { type: 'object', properties },
      ...(input.rawMeta ? { _meta: input.rawMeta } : {})
    }
  }
}

function buildCapability(input: {
  definitions: readonly MCPToolDefinition[]
  providerActiveDefinitions?: readonly MCPToolDefinition[]
  maxOutputBytes?: number
}): Readonly<{ capability: ProgrammaticToolCapabilityV1; snapshot: ToolSurfaceSnapshot }> {
  const exec = input.definitions.find((definition) => definition.function.name === 'exec')
  if (!exec) throw new Error('Test capability requires exec')
  const controller = createProgrammaticToolSurfaceRunControllerV1({
    ceilingDefinitions: input.definitions,
    providerActiveDefinitions: input.providerActiveDefinitions ?? [exec],
    policyVersion: 'dispatcher-test-v1'
  })
  const snapshot = controller.build({
    request: {
      sessionId: 'session-1',
      messageId: 'message-1',
      runId: 'run-1',
      requestSeq: 1
    },
    eligibleDefinitions: input.definitions
  })
  const capability = buildProgrammaticToolCapabilityV1({
    snapshot,
    taskContractContext: null,
    ceilings: {
      maxToolEffect: 'write',
      workspace: { kind: 'runtime_default' },
      maxSubagentDepth: 0
    },
    quotas: {
      maxChildren: 8,
      maxBatchSteps: 8,
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024,
      maxDurationMs: 30_000
    }
  })
  return { capability, snapshot }
}

function operationGrant(
  capability: ProgrammaticToolCapabilityV1,
  verb: AgentCliProgrammaticToolVerb
): AgentCliProgrammaticOperationGrant {
  const operation = {
    sessionId: capability.request.sessionId,
    messageId: capability.request.messageId,
    runId: capability.request.runId,
    requestSeq: capability.request.requestSeq,
    providerToolCallId: 'provider-call-1'
  }
  return {
    schemaVersion: AGENT_CLI_PROGRAMMATIC_GRANT_SCHEMA_VERSION,
    surfaceVersion: LOCAL_CONTROL_PROGRAMMATIC_ROUTE_SURFACE_VERSION,
    operation,
    command: { domain: 'tool', verb },
    route: `tool.${verb}`,
    canonicalInvocationHash: 'b'.repeat(64),
    adapterMode: 'cli-programmatic',
    capabilityHash: capability.capabilityHash,
    programmaticSurfaceHash: capability.programmaticSurfaceHash,
    quotas: capability.quotas,
    outerDispatchReceipt: { sessionId: operation.sessionId, entryId: 1 }
  }
}

function agentCaller(conversationId = 'session-1'): CliRouteCaller {
  return {
    kind: 'cli',
    principal: 'agent',
    connectionId: 'connection-1',
    tokenId: 'token-1',
    scopes: [],
    conversationId,
    expiresAt: Date.now() + 60_000
  }
}

function createDispatcher(input: ReturnType<typeof buildCapability>) {
  const resolveInvocation = vi.fn(() => input)
  return {
    dispatcher: new ProgrammaticToolDispatcher({ parents: { resolveInvocation } }),
    resolveInvocation
  }
}

async function expectCliError(
  promise: Promise<unknown>,
  code: LocalControlErrorCode
): Promise<CliRequestError> {
  try {
    await promise
    throw new Error('Expected CliRequestError')
  } catch (error) {
    expect(error).toBeInstanceOf(CliRequestError)
    expect((error as CliRequestError).code).toBe(code)
    return error as CliRequestError
  }
}

describe('ProgrammaticToolDispatcher', () => {
  it('searches only the frozen Programmatic Surface with deterministic bounded summaries', async () => {
    const exec = agentExec()
    const nativePinned = mcpTool({ name: 'calendar_native' })
    const zeta = mcpTool({ name: 'calendar_zeta' })
    const alpha = mcpTool({
      name: 'calendar_alpha',
      description: `calendar ${'😀'.repeat(3_000)}`,
      effect: 'write',
      properties: Object.fromEntries(
        Array.from({ length: 70 }, (_, index) => [`field_${index}`, { type: 'string' }])
      ),
      required: ['field_0']
    })
    const context = buildCapability({
      definitions: [zeta, nativePinned, exec, alpha],
      providerActiveDefinitions: [exec, nativePinned]
    })
    const { dispatcher } = createDispatcher(context)

    const output = toolSearchRoute.output.parse(
      await dispatcher.dispatch(
        toolSearchRoute.name,
        { query: 'calendar', limit: 32 },
        agentCaller(),
        operationGrant(context.capability, 'search'),
        new AbortController().signal
      )
    )

    expect(output.tools.map((tool) => tool.name)).toEqual(['calendar_alpha', 'calendar_zeta'])
    expect(output.tools.some((tool) => tool.name === 'calendar_native')).toBe(false)
    expect(output.tools[0]).toMatchObject({ source: 'mcp', effect: 'write' })
    expect(output.tools[0]?.description.length).toBeLessThanOrEqual(2_048)
    expect(output.tools[0]?.description).not.toMatch(/[\uD800-\uDBFF]$/u)
    expect(output.tools[0]?.inputSignature).toContain('field_0: string')
    expect(output.tools[0]?.inputSignature).toContain('...')
    expect(output.tools[0]?.callExample).toContain('deepchat tool call')
    expect(output.truncated).toBe(false)
  })

  it('describes canonical input schema without exposing internal target metadata', async () => {
    const secretMarker = 'must-not-leak-from-mcp-meta'
    const exec = agentExec()
    const remote = mcpTool({
      name: 'remote_search',
      properties: { query: { type: 'string' } },
      required: ['query'],
      rawMeta: { secretMarker }
    })
    const context = buildCapability({ definitions: [exec, remote] })
    const { dispatcher } = createDispatcher(context)

    const output = toolDescribeRoute.output.parse(
      await dispatcher.dispatch(
        toolDescribeRoute.name,
        { target: 'remote_search' },
        agentCaller(),
        operationGrant(context.capability, 'describe'),
        new AbortController().signal
      )
    )
    const serialized = JSON.stringify(output)

    expect(output.tool.inputSchema).toEqual(remote.function.parameters)
    expect(output.tool.callExample).toContain('remote_search')
    expect(serialized).not.toContain(SERVER_ID)
    expect(serialized).not.toContain(BINDING_HASH)
    expect(serialized).not.toContain(context.capability.capabilityHash)
    expect(serialized).not.toContain(secretMarker)
  })

  it('rejects target and property names that cannot cross the CLI boundary safely', () => {
    const exec = agentExec()
    expect(() =>
      buildCapability({ definitions: [exec, mcpTool({ name: 'remote\nsearch' })] })
    ).toThrow('target name that cannot cross the CLI boundary')
    expect(() =>
      buildCapability({
        definitions: [
          exec,
          mcpTool({ name: 'remote_search', properties: { 'unsafe\u202ename': { type: 'string' } } })
        ]
      })
    ).toThrow('input property that cannot cross the CLI boundary')
  })

  it('uses one anti-oracle shape for unknown and provider-active targets', async () => {
    const exec = agentExec()
    const nativePinned = mcpTool({ name: 'calendar_native' })
    const context = buildCapability({
      definitions: [exec, nativePinned, mcpTool({ name: 'remote_search' })],
      providerActiveDefinitions: [exec, nativePinned]
    })
    const { dispatcher } = createDispatcher(context)
    const grant = operationGrant(context.capability, 'describe')

    const unknown = await expectCliError(
      dispatcher.dispatch(
        toolDescribeRoute.name,
        { target: 'does_not_exist' },
        agentCaller(),
        grant,
        new AbortController().signal
      ),
      'not_found'
    )
    const providerActive = await expectCliError(
      dispatcher.dispatch(
        toolDescribeRoute.name,
        { target: 'calendar_native' },
        agentCaller(),
        grant,
        new AbortController().signal
      ),
      'not_found'
    )

    expect(providerActive.message).toBe(unknown.message)
    expect(providerActive.httpStatus).toBe(unknown.httpStatus)
  })

  it('truncates search to the capability output quota and rejects oversized descriptions', async () => {
    const exec = agentExec()
    const context = buildCapability({
      definitions: [exec, mcpTool({ name: 'remote_search' })],
      maxOutputBytes: 100
    })
    const { dispatcher } = createDispatcher(context)

    const search = toolSearchRoute.output.parse(
      await dispatcher.dispatch(
        toolSearchRoute.name,
        { query: 'remote' },
        agentCaller(),
        operationGrant(context.capability, 'search'),
        new AbortController().signal
      )
    )
    expect(search).toEqual({ tools: [], truncated: true })

    await expectCliError(
      dispatcher.dispatch(
        toolDescribeRoute.name,
        { target: 'remote_search' },
        agentCaller(),
        operationGrant(context.capability, 'describe'),
        new AbortController().signal
      ),
      'result_too_large'
    )
  })

  it('fails closed for mismatched callers, grants, missing live authority, and execution routes', async () => {
    const context = buildCapability({
      definitions: [agentExec(), mcpTool({ name: 'remote_search' })]
    })
    const { dispatcher, resolveInvocation } = createDispatcher(context)

    await expectCliError(
      dispatcher.dispatch(
        toolSearchRoute.name,
        { query: 'remote' },
        agentCaller('another-session'),
        operationGrant(context.capability, 'search'),
        new AbortController().signal
      ),
      'authentication_failed'
    )
    await expectCliError(
      dispatcher.dispatch(
        toolSearchRoute.name,
        { query: 'remote' },
        agentCaller(),
        operationGrant(context.capability, 'describe'),
        new AbortController().signal
      ),
      'authentication_failed'
    )
    expect(resolveInvocation).not.toHaveBeenCalled()

    resolveInvocation.mockImplementationOnce(() => {
      throw new Error('authority revoked')
    })
    await expectCliError(
      dispatcher.dispatch(
        toolSearchRoute.name,
        { query: 'remote' },
        agentCaller(),
        operationGrant(context.capability, 'search'),
        new AbortController().signal
      ),
      'authentication_failed'
    )

    await expectCliError(
      dispatcher.dispatch(
        toolCallRoute.name,
        { target: 'remote_search', arguments: {} },
        agentCaller(),
        operationGrant(context.capability, 'call'),
        new AbortController().signal
      ),
      'unavailable'
    )
    await expectCliError(
      dispatcher.dispatch(
        toolBatchRoute.name,
        { steps: [{ target: 'remote_search', arguments: {} }] },
        agentCaller(),
        operationGrant(context.capability, 'batch'),
        new AbortController().signal
      ),
      'unavailable'
    )
  })

  it('propagates cancellation before consulting process-live authority', async () => {
    const context = buildCapability({
      definitions: [agentExec(), mcpTool({ name: 'remote_search' })]
    })
    const { dispatcher, resolveInvocation } = createDispatcher(context)
    const controller = new AbortController()
    controller.abort(new Error('cancelled by test'))

    await expect(
      dispatcher.dispatch(
        toolSearchRoute.name,
        { query: 'remote' },
        agentCaller(),
        operationGrant(context.capability, 'search'),
        controller.signal
      )
    ).rejects.toThrow('cancelled by test')
    expect(resolveInvocation).not.toHaveBeenCalled()
  })
})
