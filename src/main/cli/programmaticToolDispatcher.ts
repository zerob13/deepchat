import type { ProgrammaticToolCapabilityV1 } from '@/agent/deepchat/runtime/programmaticToolSurface'
import type { CliRouteCaller } from '@/routes/routeRegistry'
import { canonicalJsonStringifyData, hashJsonData } from '@/tape/domain/canonicalJson'
import type { AgentCliProgrammaticOperationGrant } from './agentTokenAuthority'
import { CliRequestError } from './errors'
import { ProgrammaticParentOperationError } from './programmaticToolParentController'
import type { ProgrammaticToolParentRegistry } from './programmaticToolParentRegistry'
import {
  PROGRAMMATIC_TOOL_DESCRIPTION_MAX_CHARACTERS,
  PROGRAMMATIC_TOOL_EXAMPLE_MAX_CHARACTERS,
  PROGRAMMATIC_TOOL_NAME_MAX_CHARACTERS,
  PROGRAMMATIC_TOOL_SIGNATURE_MAX_CHARACTERS,
  toolCallRoute,
  toolDescribeRoute,
  toolSearchRoute
} from '@shared/contracts/routes/tools.routes'
import type { JsonValue } from '@shared/contracts/common'
import type {
  MCPToolCall,
  MCPToolResponse,
  ToolDispatchCommit,
  ToolOutcomeProjectionRegistrar
} from '@shared/types/core/mcp'
import type { ToolPermissionPreCheckResult } from '@shared/types/tool'
import {
  CommittedToolOutcomeProjectionError,
  ExecutionJournalError,
  isExecutionJournalError
} from '@/tape/domain/executionJournal'

const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_TOKENS = 32
const MAX_SIGNATURE_PROPERTIES = 64
const SEARCH_ABORT_CHECK_INTERVAL = 32
const MAX_CHILD_ERROR_CHARACTERS = 4_096

type ProgrammaticToolEntry = ProgrammaticToolCapabilityV1['entries'][number]

type ProgrammaticToolSummary = Readonly<{
  name: string
  source: 'mcp' | 'plugin'
  effect: 'read' | 'write'
  description: string
  inputSignature: string
  callExample: string
}>

export type ProgrammaticToolDispatcherOptions = Readonly<{
  parents: Pick<
    ProgrammaticToolParentRegistry,
    | 'commitChildDispatch'
    | 'commitChildOutcome'
    | 'failToolInvocationBeforePlan'
    | 'materializeChild'
    | 'recordDiscoveryResult'
    | 'recordToolInvocationResult'
    | 'reserveChildren'
    | 'resolveInvocation'
    | 'stopBeforeChild'
  >
  executeChild(input: {
    request: MCPToolCall
    capability: ProgrammaticToolCapabilityV1
    snapshot: ReturnType<ProgrammaticToolParentRegistry['resolveInvocation']>['snapshot']
    entry: ProgrammaticToolEntry
    permissionMode: ReturnType<
      ProgrammaticToolParentRegistry['resolveInvocation']
    >['permissionMode']
    signal: AbortSignal
    commitDispatch: ToolDispatchCommit
    registerOutcomeProjection: ToolOutcomeProjectionRegistrar
  }): Promise<{ content: unknown; rawData: MCPToolResponse }>
  authorizeChild(input: {
    caller: CliRouteCaller
    grant: AgentCliProgrammaticOperationGrant
    childOrdinal: number
    entry: ProgrammaticToolEntry
    arguments: Readonly<Record<string, JsonValue>>
    permission: ToolPermissionPreCheckResult
    signal: AbortSignal
  }): Promise<void>
  cancelChildPermission(requestId: string, sessionId: string): void
}>

function normalizeText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const truncated = normalized.slice(0, maximum)
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1)
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated
}

function tokenize(value: string): readonly string[] {
  return Object.freeze(
    Array.from(new Set(value.match(/[\p{L}\p{N}_-]+/gu) ?? [])).slice(0, MAX_SEARCH_TOKENS)
  )
}

function searchableDescription(entry: ProgrammaticToolEntry): string {
  return normalizeText(
    entry.definition.function.description,
    PROGRAMMATIC_TOOL_DESCRIPTION_MAX_CHARACTERS
  )
}

function schemaType(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'value'
  const schema = value as Record<string, unknown>
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((item): item is string => typeof item === 'string')
    if (types.length > 0) return types.join('|')
  }
  return typeof schema.type === 'string' && schema.type ? schema.type : 'value'
}

function exampleValue(value: unknown, name: string): JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `<${name}>`
  const schema = value as Record<string, unknown>
  switch (schemaType(schema)) {
    case 'boolean':
      return false
    case 'integer':
    case 'number':
      return 0
    case 'array':
      return []
    case 'object':
      return {}
    case 'null':
      return null
    default:
      return `<${name}>`
  }
}

function inputSchema(entry: ProgrammaticToolEntry): Readonly<Record<string, unknown>> {
  return entry.definition.function.parameters
}

function inputSignature(entry: ProgrammaticToolEntry): string {
  const schema = inputSchema(entry)
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties
      : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : []
  )
  const fields = Object.entries(properties)
    .slice(0, MAX_SIGNATURE_PROPERTIES)
    .map(([name, property]) => `${name}${required.has(name) ? '' : '?'}: ${schemaType(property)}`)
  const suffix = Object.keys(properties).length > fields.length ? ', ...' : ''
  return normalizeText(
    `{ ${fields.join(', ')}${suffix} }`,
    PROGRAMMATIC_TOOL_SIGNATURE_MAX_CHARACTERS
  )
}

function callArguments(entry: ProgrammaticToolEntry): Readonly<Record<string, JsonValue>> {
  const schema = inputSchema(entry)
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties
      : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []
  return Object.freeze(
    Object.fromEntries(
      required
        .filter(
          (name) =>
            name.length <= PROGRAMMATIC_TOOL_NAME_MAX_CHARACTERS && Object.hasOwn(properties, name)
        )
        .slice(0, MAX_SIGNATURE_PROPERTIES)
        .map((name) => [name, exampleValue(properties[name], name)])
    )
  )
}

function callExample(entry: ProgrammaticToolEntry): string {
  const stdin = canonicalJsonStringifyData({
    target: entry.target.providerVisibleName,
    arguments: callArguments(entry)
  })
  const example = canonicalJsonStringifyData({ command: 'deepchat tool call', stdin })
  if (Buffer.byteLength(example, 'utf8') <= PROGRAMMATIC_TOOL_EXAMPLE_MAX_CHARACTERS) {
    return example
  }
  return canonicalJsonStringifyData({
    command: 'deepchat tool call',
    stdin: canonicalJsonStringifyData({
      target: entry.target.providerVisibleName,
      arguments: {}
    })
  })
}

function summarize(entry: ProgrammaticToolEntry): ProgrammaticToolSummary {
  return Object.freeze({
    name: entry.target.providerVisibleName,
    source: 'mcp' as const,
    effect: entry.execution.effect,
    description: searchableDescription(entry),
    inputSignature: inputSignature(entry),
    callExample: callExample(entry)
  })
}

function scoreEntry(query: string, tokens: readonly string[], summary: ProgrammaticToolSummary) {
  if (!query) return 0
  const name = summary.name.toLocaleLowerCase('en-US')
  const description = summary.description.toLocaleLowerCase('en-US')
  let score = 0
  if (name === query) score += 10_000
  else if (name.includes(query)) score += 4_000
  if (description.includes(query)) score += 2_000
  for (const token of tokens) {
    if (name === token) score += 1_000
    else if (name.includes(token)) score += 500
    if (description.includes(token)) score += 200
    if (summary.effect === token) score += 50
  }
  return score
}

function unavailableTarget(): never {
  throw new CliRequestError('not_found', 'Tool is not available in the current session', {
    httpStatus: 404
  })
}

function unavailableStep() {
  return Object.freeze({
    childOrdinal: 0,
    status: 'error' as const,
    error: Object.freeze({
      code: 'not_found',
      message: 'Tool is not available in the current session',
      retriable: false
    })
  })
}

function errorStep(code: string, message: string, retriable: boolean) {
  return Object.freeze({
    childOrdinal: 0,
    status: 'error' as const,
    error: Object.freeze({
      code,
      message:
        normalizeText(message, MAX_CHILD_ERROR_CHARACTERS) || 'Programmatic Tool execution failed',
      retriable
    })
  })
}

function formatSuccessfulOuterResponse(output: unknown): string {
  return `${JSON.stringify(output, null, 2)}\nExit Code: 0`
}

function formatFailedOuterResponse(error: CliRequestError): string {
  return `Error: ${error.message}`
}

function measureOuterResponseBytes(output: unknown): number {
  return Buffer.byteLength(formatSuccessfulOuterResponse(output), 'utf8')
}

function assertOutputWithinCapabilityQuota(
  output: unknown,
  capability: ProgrammaticToolCapabilityV1
): void {
  if (measureOuterResponseBytes(output) <= capability.quotas.maxOutputBytes) return
  throw new CliRequestError(
    'result_too_large',
    'Programmatic Tool result exceeds its output quota',
    {
      httpStatus: 413
    }
  )
}

function isProgrammaticProtocolFailure(error: unknown): boolean {
  return (
    isExecutionJournalError(error) ||
    (error instanceof ProgrammaticParentOperationError &&
      error.code !== 'invalid_plan' &&
      error.code !== 'quota_exceeded')
  )
}

function childResponseText(result: { content: unknown; rawData: MCPToolResponse }): string {
  if (typeof result.content === 'string') return result.content
  if (typeof result.rawData.content === 'string') return result.rawData.content
  return result.rawData.content
    .map((item) => {
      if (item.type === 'text') return item.text
      if (item.type === 'resource' && item.resource?.text) return item.resource.text
      return `[${item.type}]`
    })
    .join('\n')
}

function boundedChildOutcome(input: {
  result: { content: unknown; rawData: MCPToolResponse }
  capability: ProgrammaticToolCapabilityV1
}): Readonly<{
  responseText: string
  isError: boolean
  output: ReturnType<typeof toolCallRoute.output.parse>
}> {
  const responseText = childResponseText(input.result)
  const isError = input.result.rawData.isError === true
  const output = toolCallRoute.output.parse({
    step: isError
      ? errorStep('tool_error', responseText, false)
      : { childOrdinal: 0, status: 'success', result: responseText }
  })
  if (
    Buffer.byteLength(responseText, 'utf8') <= input.capability.quotas.maxOutputBytes &&
    measureOuterResponseBytes(output) <= input.capability.quotas.maxOutputBytes
  ) {
    return Object.freeze({ responseText, isError, output })
  }

  const quotaText = 'Programmatic Tool result exceeds its output quota'
  const quotaOutput = toolCallRoute.output.parse({
    step: errorStep('result_too_large', quotaText, false)
  })
  assertOutputWithinCapabilityQuota(quotaOutput, input.capability)
  return Object.freeze({ responseText: quotaText, isError: true, output: quotaOutput })
}

export class ProgrammaticToolDispatcher {
  constructor(private readonly options: ProgrammaticToolDispatcherOptions) {}

  async dispatch(
    method: string,
    input: unknown,
    caller: CliRouteCaller,
    grant: AgentCliProgrammaticOperationGrant,
    signal: AbortSignal
  ): Promise<unknown> {
    signal.throwIfAborted()
    if (
      caller.principal !== 'agent' ||
      caller.conversationId !== grant.operation.sessionId ||
      method !== grant.route
    ) {
      throw new CliRequestError(
        'authentication_failed',
        'Programmatic invocation authority is unavailable',
        { httpStatus: 401 }
      )
    }
    let capability: ProgrammaticToolCapabilityV1
    let invocation: ReturnType<ProgrammaticToolParentRegistry['resolveInvocation']>
    try {
      invocation = this.options.parents.resolveInvocation(grant)
      capability = invocation.capability
    } catch {
      throw new CliRequestError(
        'authentication_failed',
        'Programmatic invocation authority is unavailable',
        { httpStatus: 401 }
      )
    }
    signal.throwIfAborted()

    if (method === toolSearchRoute.name) {
      try {
        const query = toolSearchRoute.input.parse(input)
        const normalizedQuery = normalizeText(query.query, query.query.length).toLocaleLowerCase(
          'en-US'
        )
        const tokens = tokenize(normalizedQuery)
        const matches: Array<Readonly<{ summary: ProgrammaticToolSummary; score: number }>> = []
        for (let index = 0; index < capability.entries.length; index += 1) {
          if (index % SEARCH_ABORT_CHECK_INTERVAL === 0) signal.throwIfAborted()
          const summary = summarize(capability.entries[index])
          const score = scoreEntry(normalizedQuery, tokens, summary)
          if (score > 0) matches.push({ summary, score })
        }
        matches.sort(
          (left, right) =>
            right.score - left.score ||
            (left.summary.name < right.summary.name
              ? -1
              : left.summary.name > right.summary.name
                ? 1
                : 0)
        )
        const limit = query.limit ?? DEFAULT_SEARCH_LIMIT
        const selected = matches.slice(0, limit).map((match) => match.summary)
        const output = {
          tools: selected,
          truncated: matches.length > limit
        }
        while (
          output.tools.length > 0 &&
          measureOuterResponseBytes(output) > capability.quotas.maxOutputBytes
        ) {
          output.tools.pop()
          output.truncated = true
        }
        assertOutputWithinCapabilityQuota(output, capability)
        signal.throwIfAborted()
        const result = toolSearchRoute.output.parse(output)
        this.options.parents.recordDiscoveryResult(grant, {
          responseText: formatSuccessfulOuterResponse(result),
          isError: false
        })
        return result
      } catch (error) {
        if (error instanceof CliRequestError) {
          this.options.parents.recordDiscoveryResult(grant, {
            responseText: formatFailedOuterResponse(error),
            isError: true
          })
        }
        throw error
      }
    }

    if (method === toolDescribeRoute.name) {
      try {
        const request = toolDescribeRoute.input.parse(input)
        const entry = capability.entries.find(
          (candidate) => candidate.target.providerVisibleName === request.target
        )
        if (!entry) unavailableTarget()
        const output = {
          tool: {
            ...summarize(entry),
            inputSchema: inputSchema(entry)
          }
        }
        assertOutputWithinCapabilityQuota(output, capability)
        signal.throwIfAborted()
        const result = toolDescribeRoute.output.parse(output)
        this.options.parents.recordDiscoveryResult(grant, {
          responseText: formatSuccessfulOuterResponse(result),
          isError: false
        })
        return result
      } catch (error) {
        if (error instanceof CliRequestError) {
          this.options.parents.recordDiscoveryResult(grant, {
            responseText: formatFailedOuterResponse(error),
            isError: true
          })
        }
        throw error
      }
    }

    if (method === toolCallRoute.name) {
      const request = toolCallRoute.input.parse(input)
      const entry = capability.entries.find(
        (candidate) => candidate.target.providerVisibleName === request.target
      )
      if (!entry) {
        const output = toolCallRoute.output.parse({ step: unavailableStep() })
        assertOutputWithinCapabilityQuota(output, capability)
        this.options.parents.failToolInvocationBeforePlan(grant, {
          responseText: formatSuccessfulOuterResponse(output),
          isError: true
        })
        return output
      }

      const argumentTemplate = Object.freeze({
        arguments: request.arguments,
        bindings: Object.freeze([])
      })
      try {
        this.options.parents.reserveChildren(grant, [
          {
            childOrdinal: 0,
            toolName: entry.target.providerVisibleName,
            toolSource: 'mcp',
            target: {
              serverName: entry.target.serverName,
              originalName: entry.target.originalName
            },
            definitionHash: entry.canonicalToolDefinitionHash,
            argumentTemplate
          }
        ])
      } catch (error) {
        if (
          !(error instanceof ProgrammaticParentOperationError) ||
          (error.code !== 'invalid_plan' && error.code !== 'quota_exceeded')
        ) {
          throw error
        }
        const output = toolCallRoute.output.parse({
          step: errorStep(
            error.code === 'quota_exceeded' ? 'quota_exceeded' : 'invalid_request',
            error.message,
            false
          )
        })
        assertOutputWithinCapabilityQuota(output, capability)
        this.options.parents.recordToolInvocationResult(grant, {
          responseText: formatSuccessfulOuterResponse(output),
          isError: true
        })
        return output
      }

      const operationSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(capability.quotas.maxDurationMs)
      ])
      const pendingOutcomeProjections: Array<() => void> = []
      let dispatchCommitted = false
      let dispatchBoundaryFailed = false
      const nestedOperation = Object.freeze({
        kind: 'nested' as const,
        runId: grant.operation.runId,
        requestSeq: grant.operation.requestSeq,
        providerToolCallId: grant.operation.providerToolCallId,
        childOrdinal: 0
      })
      const releaseOutcomeProjections = (): void => {
        try {
          for (const project of pendingOutcomeProjections.splice(0)) project()
        } catch (cause) {
          throw new CommittedToolOutcomeProjectionError(nestedOperation, { cause })
        }
      }
      const execute = async () =>
        await this.options.executeChild({
          request: {
            id: `programmatic-${hashJsonData({
              operation: grant.operation,
              childOrdinal: 0
            }).slice(0, 32)}`,
            type: 'function',
            function: {
              name: entry.target.providerVisibleName,
              arguments: canonicalJsonStringifyData(request.arguments)
            },
            conversationId: capability.request.sessionId
          },
          capability,
          snapshot: invocation.snapshot,
          entry,
          permissionMode: invocation.permissionMode,
          signal: operationSignal,
          commitDispatch: (dispatch) => {
            if (dispatchCommitted) {
              dispatchBoundaryFailed = true
              throw new ExecutionJournalError(
                'Programmatic child attempted more than one durable dispatch commit.',
                'duplicate_dispatch'
              )
            }
            this.options.parents.materializeChild(grant, {
              childOrdinal: 0,
              argumentTemplate,
              normalizedArguments: dispatch.normalizedArguments
            })
            dispatchBoundaryFailed = true
            try {
              this.options.parents.commitChildDispatch(grant, 0, dispatch)
              dispatchCommitted = true
            } finally {
              if (dispatchCommitted) dispatchBoundaryFailed = false
            }
          },
          registerOutcomeProjection: (projection) => pendingOutcomeProjections.push(projection)
        })

      let executed: Awaited<ReturnType<typeof execute>>
      try {
        executed = await execute()
        if (executed.rawData.requiresPermission) {
          const permission = executed.rawData.permissionRequest
          const requestId = permission?.requestId?.trim()
          if (dispatchCommitted) {
            if (requestId) {
              this.options.cancelChildPermission(requestId, capability.request.sessionId)
            }
            throw new ExecutionJournalError(
              'Programmatic child requested permission after its durable dispatch commit.',
              'invalid_fact'
            )
          }
          if (!permission || !requestId) {
            throw new CliRequestError(
              'unavailable',
              'Programmatic Tool permission authority is unavailable',
              { httpStatus: 503 }
            )
          }
          try {
            await this.options.authorizeChild({
              caller,
              grant,
              childOrdinal: 0,
              entry,
              arguments: request.arguments,
              permission: permission as ToolPermissionPreCheckResult,
              signal: operationSignal
            })
            executed = await execute()
          } finally {
            this.options.cancelChildPermission(requestId, capability.request.sessionId)
          }
          if (executed.rawData.requiresPermission) {
            const repeatedRequestId = executed.rawData.permissionRequest?.requestId?.trim()
            if (repeatedRequestId) {
              this.options.cancelChildPermission(repeatedRequestId, capability.request.sessionId)
            }
            throw new CliRequestError(
              'approval_denied',
              'Programmatic Tool permission was not consumed',
              { httpStatus: 403 }
            )
          }
        }
      } catch (error) {
        if (dispatchBoundaryFailed) throw error
        if (isProgrammaticProtocolFailure(error)) throw error
        if (dispatchCommitted) {
          if (operationSignal.aborted) throw error
          const childOutcome = boundedChildOutcome({
            result: {
              content: `Error: ${
                error instanceof Error ? error.message : 'Programmatic Tool execution failed'
              }`,
              rawData: {
                toolCallId: nestedOperation.providerToolCallId,
                content: `Error: ${
                  error instanceof Error ? error.message : 'Programmatic Tool execution failed'
                }`,
                isError: true
              }
            },
            capability
          })
          this.options.parents.commitChildOutcome(grant, {
            childOrdinal: 0,
            responseText: childOutcome.responseText,
            isError: true
          })
          releaseOutcomeProjections()
          this.options.parents.recordToolInvocationResult(grant, {
            responseText: formatSuccessfulOuterResponse(childOutcome.output),
            isError: true
          })
          return childOutcome.output
        }

        if (pendingOutcomeProjections.length > 0) {
          throw new ExecutionJournalError(
            'Programmatic child registered an outcome projection without a durable dispatch.',
            'invalid_fact'
          )
        }
        this.options.parents.stopBeforeChild(grant, 0)
        const step =
          error instanceof CliRequestError
            ? errorStep(error.code, error.message, error.retriable)
            : error instanceof ProgrammaticParentOperationError
              ? errorStep(
                  error.code === 'quota_exceeded' ? 'quota_exceeded' : 'invalid_request',
                  error.message,
                  false
                )
              : unavailableStep()
        const output = toolCallRoute.output.parse({ step })
        assertOutputWithinCapabilityQuota(output, capability)
        this.options.parents.recordToolInvocationResult(grant, {
          responseText: formatSuccessfulOuterResponse(output),
          isError: true
        })
        return output
      }

      if (!dispatchCommitted) {
        if (pendingOutcomeProjections.length > 0) {
          throw new ExecutionJournalError(
            'Programmatic child registered an outcome projection without a durable dispatch.',
            'invalid_fact'
          )
        }
        this.options.parents.stopBeforeChild(grant, 0)
        const output = toolCallRoute.output.parse({ step: unavailableStep() })
        assertOutputWithinCapabilityQuota(output, capability)
        this.options.parents.recordToolInvocationResult(grant, {
          responseText: formatSuccessfulOuterResponse(output),
          isError: true
        })
        return output
      }

      const childOutcome = boundedChildOutcome({ result: executed, capability })
      this.options.parents.commitChildOutcome(grant, {
        childOrdinal: 0,
        responseText: childOutcome.responseText,
        isError: childOutcome.isError
      })
      releaseOutcomeProjections()
      this.options.parents.recordToolInvocationResult(grant, {
        responseText: formatSuccessfulOuterResponse(childOutcome.output),
        isError: childOutcome.isError
      })
      return childOutcome.output
    }

    throw new CliRequestError('unavailable', 'Programmatic Tool execution is not available', {
      httpStatus: 503,
      retriable: false
    })
  }
}
