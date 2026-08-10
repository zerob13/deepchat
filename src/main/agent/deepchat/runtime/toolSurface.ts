import { Buffer } from 'node:buffer'
import { types as nodeTypes } from 'node:util'
import type { AgentToolExposure } from '@shared/agentTools'
import { getAgentToolExposure } from '@shared/agentTools'
import {
  stripToolExecutionContract,
  type MCPToolDefinition,
  type ToolExecutionContract
} from '@shared/types/core/mcp'
import type { DeepChatExecutionToolTargetIdentity } from '@shared/types/execution-contract'
import { canonicalJsonStringifyData, hashJsonData } from '@/tape/domain/canonicalJson'
import {
  buildExecutionToolCeiling,
  buildExecutionToolTargetKey,
  buildProviderVisibleToolDefinitionsHash
} from '@/tape/domain/executionContract'
import { estimateToolDefinitionTokens } from './contextBuilder'

export const TOOL_SURFACE_CATALOG_SCHEMA_VERSION = 1
export const TOOL_SURFACE_CANONICALIZATION_VERSION = 'deepchat-tool-definition-v1'
export const MAX_TOOL_SURFACE_DEFINITIONS = 1_024
export const MAX_TOOL_SURFACE_DEFINITION_BYTES = 256 * 1_024
export const MAX_TOOL_SURFACE_TOTAL_DEFINITION_BYTES = 4 * 1_024 * 1_024
export const MAX_TOOL_SURFACE_DEFINITION_DEPTH = 64
export const MAX_TOOL_SURFACE_DEFINITION_NODES = 100_000
export const MAX_TOOL_SURFACE_TOTAL_INPUT_NODES = 500_000
export const MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES = 4 * 1_024 * 1_024

const CANONICAL_JSON_OPTIONS = Object.freeze({ omitUndefinedProperties: true })

export type ToolSurfaceErrorCode =
  | 'conflicting_tool'
  | 'ineligible_exposure'
  | 'invalid_definition'
  | 'limit_exceeded'

export class ToolSurfaceError extends Error {
  constructor(
    message: string,
    readonly code: ToolSurfaceErrorCode
  ) {
    super(message)
    this.name = 'ToolSurfaceError'
  }
}

export interface CanonicalToolCatalogEntry {
  readonly target: DeepChatExecutionToolTargetIdentity
  readonly stableTargetKey: string
  readonly canonicalToolDefinitionHash: string
  readonly exposure: Extract<AgentToolExposure, 'user-configurable' | 'system-model'>
  readonly execution: ToolExecutionContract
  readonly definitionTokens: number
  readonly canonicalDefinitionBytes: number
}

export interface CanonicalToolCatalog {
  readonly schemaVersion: typeof TOOL_SURFACE_CATALOG_SCHEMA_VERSION
  readonly canonicalizationVersion: typeof TOOL_SURFACE_CANONICALIZATION_VERSION
  readonly fullCatalogHash: string
  readonly entries: readonly CanonicalToolCatalogEntry[]
  readonly definitionTokens: number
  readonly canonicalDefinitionBytes: number
}

type JsonTraversalItem =
  | {
      readonly kind: 'enter'
      readonly value: unknown
      readonly depth: number
      readonly label: string
    }
  | { readonly kind: 'exit'; readonly value: object }

interface CanonicalInputBudget {
  readonly maxBytes: number
  readonly maxNodes: number
}

interface CanonicalInputMeasurement {
  readonly bytes: number
  readonly nodes: number
}

interface BuiltCatalogEntry {
  readonly entry: CanonicalToolCatalogEntry
  readonly input: CanonicalInputMeasurement
}

function failInvalidDefinition(message: string): never {
  throw new ToolSurfaceError(message, 'invalid_definition')
}

function encodedJsonBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function addCanonicalBytes(
  current: number,
  added: number,
  label: string,
  budget: CanonicalInputBudget
): number {
  const next = current + added
  if (next > MAX_TOOL_SURFACE_DEFINITION_BYTES || next > budget.maxBytes) {
    throw new ToolSurfaceError(
      `${label} exceeds the bounded canonical input byte budget.`,
      'limit_exceeded'
    )
  }
  return next
}

function measureBoundedCanonicalInput(
  value: unknown,
  label: string,
  budget: CanonicalInputBudget
): CanonicalInputMeasurement {
  const ancestors = new Set<object>()
  const stack: JsonTraversalItem[] = [{ kind: 'enter', value, depth: 0, label }]
  let nodes = 0
  let bytes = 0

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) break
    if (item.kind === 'exit') {
      ancestors.delete(item.value)
      continue
    }

    nodes += 1
    if (nodes > MAX_TOOL_SURFACE_DEFINITION_NODES || nodes > budget.maxNodes) {
      throw new ToolSurfaceError(
        `${label} exceeds the bounded canonical input node budget.`,
        'limit_exceeded'
      )
    }
    if (item.depth > MAX_TOOL_SURFACE_DEFINITION_DEPTH) {
      throw new ToolSurfaceError(
        `${label} exceeds canonical input depth ${MAX_TOOL_SURFACE_DEFINITION_DEPTH}.`,
        'limit_exceeded'
      )
    }

    if (item.value === null) {
      bytes = addCanonicalBytes(bytes, 4, label, budget)
      continue
    }
    if (typeof item.value === 'boolean') {
      bytes = addCanonicalBytes(bytes, item.value ? 4 : 5, label, budget)
      continue
    }
    if (typeof item.value === 'string') {
      bytes = addCanonicalBytes(bytes, encodedJsonBytes(item.value), label, budget)
      continue
    }
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) failInvalidDefinition(`${item.label} is not finite.`)
      bytes = addCanonicalBytes(bytes, Buffer.byteLength(JSON.stringify(item.value)), label, budget)
      continue
    }
    if (!item.value || typeof item.value !== 'object') {
      failInvalidDefinition(`${item.label} contains a non-JSON value.`)
    }
    if (ancestors.has(item.value)) {
      failInvalidDefinition(`${item.label} contains a circular reference.`)
    }
    if (nodeTypes.isProxy(item.value)) {
      failInvalidDefinition(`${item.label} contains a Proxy object.`)
    }
    if (Object.getOwnPropertySymbols(item.value).length > 0) {
      failInvalidDefinition(`${item.label} contains a symbol property.`)
    }

    ancestors.add(item.value)
    stack.push({ kind: 'exit', value: item.value })

    if (Array.isArray(item.value)) {
      const keys = Object.getOwnPropertyNames(item.value).filter((key) => key !== 'length')
      if (keys.length !== item.value.length) {
        failInvalidDefinition(`${item.label} contains a sparse array or non-index property.`)
      }
      bytes = addCanonicalBytes(bytes, 2 + Math.max(0, item.value.length - 1), label, budget)
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item.value, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          failInvalidDefinition(`${item.label}[${index}] is not an enumerable data property.`)
        }
        stack.push({
          kind: 'enter',
          value: descriptor.value,
          depth: item.depth + 1,
          label: `${item.label}[${index}]`
        })
      }
      continue
    }

    const prototype = Object.getPrototypeOf(item.value)
    if (prototype !== Object.prototype && prototype !== null) {
      failInvalidDefinition(`${item.label} contains a non-plain object.`)
    }
    const keys = Object.getOwnPropertyNames(item.value).sort()
    let includedProperties = 0
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        failInvalidDefinition(`${item.label} contains a non-enumerable or accessor property.`)
      }
      if (descriptor.value === undefined) continue
      bytes = addCanonicalBytes(
        bytes,
        encodedJsonBytes(key) + 1 + (includedProperties > 0 ? 1 : 0),
        label,
        budget
      )
      includedProperties += 1
      stack.push({
        kind: 'enter',
        value: descriptor.value,
        depth: item.depth + 1,
        label: `${item.label} property`
      })
    }
    bytes = addCanonicalBytes(bytes, 2, label, budget)
  }

  return { bytes, nodes }
}

function resolveModelExposure(
  definition: MCPToolDefinition
): CanonicalToolCatalogEntry['exposure'] {
  if (definition.source === 'mcp') return 'user-configurable'
  const exposure = getAgentToolExposure(definition.function.name)
  if (exposure === 'diagnostic' || exposure === 'runtime-only') {
    throw new ToolSurfaceError('Tool definition has non-model exposure.', 'ineligible_exposure')
  }
  return exposure
}

function buildCatalogEntry(
  definition: MCPToolDefinition,
  index: number,
  budget: CanonicalInputBudget
): BuiltCatalogEntry {
  const label = `tools[${index}]`
  const input = measureBoundedCanonicalInput(definition, label, budget)

  try {
    const detachedDefinition = JSON.parse(
      canonicalJsonStringifyData(definition, CANONICAL_JSON_OPTIONS)
    ) as MCPToolDefinition
    const baseDefinition = stripToolExecutionContract(detachedDefinition)
    const serialized = canonicalJsonStringifyData(baseDefinition, CANONICAL_JSON_OPTIONS)
    const canonicalDefinitionBytes = Buffer.byteLength(serialized, 'utf8')
    if (canonicalDefinitionBytes > MAX_TOOL_SURFACE_DEFINITION_BYTES) {
      throw new ToolSurfaceError(
        `${label} exceeds ${MAX_TOOL_SURFACE_DEFINITION_BYTES} canonical bytes.`,
        'limit_exceeded'
      )
    }

    const target: DeepChatExecutionToolTargetIdentity =
      buildExecutionToolCeiling(detachedDefinition).target
    return {
      entry: {
        target,
        stableTargetKey: buildExecutionToolTargetKey(target),
        canonicalToolDefinitionHash: buildProviderVisibleToolDefinitionsHash([detachedDefinition]),
        exposure: resolveModelExposure(detachedDefinition),
        execution: detachedDefinition.execution,
        definitionTokens: estimateToolDefinitionTokens([detachedDefinition]),
        canonicalDefinitionBytes
      },
      input
    }
  } catch (error) {
    if (error instanceof ToolSurfaceError) throw error
    throw new ToolSurfaceError(`${label} is not a canonical Tool definition.`, 'invalid_definition')
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function freezeCatalog(catalog: CanonicalToolCatalog): CanonicalToolCatalog {
  for (const entry of catalog.entries) {
    Object.freeze(entry.target)
    Object.freeze(entry.execution)
    Object.freeze(entry)
  }
  Object.freeze(catalog.entries)
  return Object.freeze(catalog)
}

export function buildCanonicalToolCatalog(
  definitions: readonly MCPToolDefinition[]
): CanonicalToolCatalog {
  if (definitions.length > MAX_TOOL_SURFACE_DEFINITIONS) {
    throw new ToolSurfaceError(
      `Tool catalog has more than ${MAX_TOOL_SURFACE_DEFINITIONS} definitions.`,
      'limit_exceeded'
    )
  }

  const entryByTarget = new Map<string, CanonicalToolCatalogEntry>()
  const targetByVisibleName = new Map<string, string>()
  let canonicalDefinitionBytes = 0
  let inputBytes = 0
  let inputNodes = 0

  definitions.forEach((definition, index) => {
    const built = buildCatalogEntry(definition, index, {
      maxBytes: MAX_TOOL_SURFACE_TOTAL_INPUT_BYTES - inputBytes,
      maxNodes: MAX_TOOL_SURFACE_TOTAL_INPUT_NODES - inputNodes
    })
    inputBytes += built.input.bytes
    inputNodes += built.input.nodes
    const { entry } = built
    const visibleName = entry.target.providerVisibleName
    const previousTarget = targetByVisibleName.get(visibleName)
    if (previousTarget !== undefined && previousTarget !== entry.stableTargetKey) {
      throw new ToolSurfaceError(
        `${labelFor(index)} resolves to a conflicting target.`,
        'conflicting_tool'
      )
    }
    targetByVisibleName.set(visibleName, entry.stableTargetKey)

    const previous = entryByTarget.get(entry.stableTargetKey)
    if (previous) {
      if (
        previous.canonicalToolDefinitionHash !== entry.canonicalToolDefinitionHash ||
        canonicalJsonStringifyData(previous.execution) !==
          canonicalJsonStringifyData(entry.execution) ||
        previous.exposure !== entry.exposure
      ) {
        throw new ToolSurfaceError(
          `${labelFor(index)} conflicts with a prior definition.`,
          'conflicting_tool'
        )
      }
      return
    }

    canonicalDefinitionBytes += entry.canonicalDefinitionBytes
    if (canonicalDefinitionBytes > MAX_TOOL_SURFACE_TOTAL_DEFINITION_BYTES) {
      throw new ToolSurfaceError(
        `Tool catalog exceeds ${MAX_TOOL_SURFACE_TOTAL_DEFINITION_BYTES} canonical bytes.`,
        'limit_exceeded'
      )
    }
    entryByTarget.set(entry.stableTargetKey, entry)
  })

  const entries = [...entryByTarget.values()].sort((left, right) =>
    compareCodePoints(left.stableTargetKey, right.stableTargetKey)
  )
  const fullCatalogHash = hashJsonData(
    {
      schemaVersion: TOOL_SURFACE_CATALOG_SCHEMA_VERSION,
      canonicalizationVersion: TOOL_SURFACE_CANONICALIZATION_VERSION,
      entries: entries.map((entry) => ({
        target: entry.target,
        canonicalToolDefinitionHash: entry.canonicalToolDefinitionHash,
        exposure: entry.exposure,
        execution: entry.execution
      }))
    },
    CANONICAL_JSON_OPTIONS
  )

  return freezeCatalog({
    schemaVersion: TOOL_SURFACE_CATALOG_SCHEMA_VERSION,
    canonicalizationVersion: TOOL_SURFACE_CANONICALIZATION_VERSION,
    fullCatalogHash,
    entries,
    definitionTokens: entries.reduce((total, entry) => total + entry.definitionTokens, 0),
    canonicalDefinitionBytes
  })
}

function labelFor(index: number): string {
  return `tools[${index}]`
}
