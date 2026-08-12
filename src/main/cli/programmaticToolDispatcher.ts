import type { ProgrammaticToolCapabilityV1 } from '@/agent/deepchat/runtime/programmaticToolSurface'
import type { CliRouteCaller } from '@/routes/routeRegistry'
import { canonicalJsonStringifyData } from '@/tape/domain/canonicalJson'
import type { AgentCliProgrammaticOperationGrant } from './agentTokenAuthority'
import { CliRequestError } from './errors'
import type { ProgrammaticToolParentRegistry } from './programmaticToolParentRegistry'
import {
  PROGRAMMATIC_TOOL_DESCRIPTION_MAX_CHARACTERS,
  PROGRAMMATIC_TOOL_EXAMPLE_MAX_CHARACTERS,
  PROGRAMMATIC_TOOL_NAME_MAX_CHARACTERS,
  PROGRAMMATIC_TOOL_SIGNATURE_MAX_CHARACTERS,
  toolDescribeRoute,
  toolSearchRoute
} from '@shared/contracts/routes/tools.routes'
import type { JsonValue } from '@shared/contracts/common'

const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_TOKENS = 32
const MAX_SIGNATURE_PROPERTIES = 64
const SEARCH_ABORT_CHECK_INTERVAL = 32

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
  parents: Pick<ProgrammaticToolParentRegistry, 'resolveInvocation'>
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

function measureOuterResponseBytes(output: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(output, null, 2)}\nExit Code: 0`, 'utf8')
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
    try {
      capability = this.options.parents.resolveInvocation(grant).capability
    } catch {
      throw new CliRequestError(
        'authentication_failed',
        'Programmatic invocation authority is unavailable',
        { httpStatus: 401 }
      )
    }
    signal.throwIfAborted()

    if (method === toolSearchRoute.name) {
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
      return toolSearchRoute.output.parse(output)
    }

    if (method === toolDescribeRoute.name) {
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
      return toolDescribeRoute.output.parse(output)
    }

    throw new CliRequestError('unavailable', 'Programmatic Tool execution is not available', {
      httpStatus: 503,
      retriable: false
    })
  }
}
