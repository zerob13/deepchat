import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ChatMessage } from '@shared/types/core/chat-message'
import {
  stripToolExecutionContract,
  type MCPToolDefinition,
  type ToolEffect,
  type ToolExecutionContract
} from '@shared/types/core/mcp'
import type { PermissionMode } from '@shared/types/agent-interface'
import type { ModelConfig } from '@shared/types/provider'
import {
  DEEPCHAT_PROMPT_DEGRADATION_CODES,
  DEEPCHAT_PROMPT_SECTION_INCLUSIONS,
  DEEPCHAT_PROMPT_SECTION_KINDS,
  DEEPCHAT_PROMPT_SOURCE_FRESHNESS_VALUES,
  type DeepChatPromptAssembly,
  type DeepChatPromptDegradationCode,
  type DeepChatPromptSectionProvenance
} from '@shared/types/prompt-assembly'
import {
  DEEPCHAT_EXECUTION_CONTRACT_HASH_VERSION,
  DEEPCHAT_EXECUTION_CONTRACT_SCHEMA_VERSION,
  type DeepChatExecutionContract,
  type DeepChatExecutionContractRequest,
  type DeepChatExecutionDynamicControlSnapshot,
  type DeepChatExecutionToolCeiling,
  type DeepChatExecutionToolTargetIdentity,
  type DeepChatExecutionWorkspaceCeiling
} from '@shared/types/execution-contract'
import { canonicalJsonStringifyData, hashJsonData } from './canonicalJson'

export const MAX_EXECUTION_CONTRACT_BYTES = 64 * 1024
export const MAX_EXECUTION_CONTRACT_TOOLS = 256
export const MAX_EXECUTION_CONTRACT_PROMPT_SECTIONS = 64
export const MAX_EXECUTION_CONTRACT_SUBAGENT_DEPTH = 1

const MAX_IDENTITY_BYTES = 1_024
const MAX_SOURCE_REF_BYTES = 2_048
const MAX_WORKSPACE_PATH_BYTES = 32 * 1_024
const MAX_ASSEMBLER_VERSION_BYTES = 256
const MAX_SECTION_DEGRADATION_CODES = 16
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA_256_PATTERN = /^[0-9a-f]{64}$/
const JSON_HASH_OPTIONS = Object.freeze({ omitUndefinedProperties: true })
const PROMPT_SECTION_KINDS = new Set<string>(DEEPCHAT_PROMPT_SECTION_KINDS)
const PROMPT_SECTION_INCLUSIONS = new Set<string>(DEEPCHAT_PROMPT_SECTION_INCLUSIONS)
const PROMPT_SOURCE_FRESHNESS_VALUES = new Set<string>(DEEPCHAT_PROMPT_SOURCE_FRESHNESS_VALUES)
const PROMPT_DEGRADATION_CODES = new Set<string>(DEEPCHAT_PROMPT_DEGRADATION_CODES)
const PERMISSION_MODES = new Set<PermissionMode>(['default', 'auto_approve', 'full_access'])

export interface BuildExecutionContractInput {
  request: DeepChatExecutionContractRequest
  promptAssembly: DeepChatPromptAssembly
  providerMessages: readonly ChatMessage[]
  tools: readonly MCPToolDefinition[]
  providerId: string
  modelId: string
  modelConfig: ModelConfig
  temperature: number
  maxTokens: number
  workspace: DeepChatExecutionWorkspaceCeiling
  maxSubagentDepth: number
  dynamicControlSnapshot: DeepChatExecutionDynamicControlSnapshot
  assemblerVersion: string
}

export class ExecutionContractError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'limit_exceeded' | 'conflicting_tool',
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ExecutionContractError'
  }
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function requireString(
  value: unknown,
  label: string,
  maxBytes: number,
  options: { preserveOuterWhitespace?: boolean } = {}
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    utf8Length(value) > maxBytes
  ) {
    throw new ExecutionContractError(
      `${label} must be a non-empty UTF-8 string no longer than ${maxBytes} bytes.`,
      'invalid_input'
    )
  }
  if (!options.preserveOuterWhitespace && value !== value.trim()) {
    throw new ExecutionContractError(`${label} must not contain outer whitespace.`, 'invalid_input')
  }
  return value
}

function requireUuid(value: unknown, label: string): string {
  const uuid = requireString(value, label, MAX_IDENTITY_BYTES)
  if (!UUID_PATTERN.test(uuid)) {
    throw new ExecutionContractError(`${label} must be a UUID.`, 'invalid_input')
  }
  return uuid.toLowerCase()
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA_256_PATTERN.test(value)) {
    throw new ExecutionContractError(`${label} must be a lowercase SHA-256 hash.`, 'invalid_input')
  }
  return value
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ExecutionContractError(`${label} must be a positive safe integer.`, 'invalid_input')
  }
  return value as number
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ExecutionContractError(
      `${label} must be a non-negative safe integer.`,
      'invalid_input'
    )
  }
  return value as number
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExecutionContractError(`${label} must be a finite number.`, 'invalid_input')
  }
  return value
}

function hashData(value: unknown, label: string, omitUndefinedProperties = false): string {
  try {
    return hashJsonData(value, omitUndefinedProperties ? JSON_HASH_OPTIONS : undefined)
  } catch (error) {
    throw new ExecutionContractError(`${label} must contain only JSON data.`, 'invalid_input', {
      cause: error
    })
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeExecution(value: ToolExecutionContract, label: string): ToolExecutionContract {
  if (value?.effect === 'read' && (value.mode === 'sequential' || value.mode === 'parallel')) {
    return { effect: 'read', mode: value.mode }
  }
  if (value?.effect === 'write' && value.mode === 'sequential') {
    return { effect: 'write', mode: 'sequential' }
  }
  throw new ExecutionContractError(`${label} is invalid.`, 'invalid_input')
}

function normalizeOptionalAgentBinding(definition: MCPToolDefinition): {
  serverId: string | null
  configGeneration: number | null
  bindingHash: string | null
} {
  const values = [
    definition.server?.id,
    definition.server?.configGeneration,
    definition.server?.bindingHash
  ]
  if (values.every((value) => value === undefined)) {
    return { serverId: null, configGeneration: null, bindingHash: null }
  }
  if (values.some((value) => value === undefined)) {
    throw new ExecutionContractError(
      `Agent tool ${definition.function?.name ?? '<unknown>'} has an incomplete stable binding.`,
      'invalid_input'
    )
  }
  return {
    serverId: requireUuid(definition.server.id, 'tool.server.id'),
    configGeneration: requirePositiveSafeInteger(
      definition.server.configGeneration,
      'tool.server.configGeneration'
    ),
    bindingHash: requireSha256(definition.server.bindingHash, 'tool.server.bindingHash')
  }
}

function normalizeToolCeiling(
  definition: MCPToolDefinition,
  index: number
): DeepChatExecutionToolCeiling {
  const label = `tools[${index}]`
  if (definition?.source !== 'agent' && definition?.source !== 'mcp') {
    throw new ExecutionContractError(`${label}.source must be agent or mcp.`, 'invalid_input')
  }
  const providerVisibleName = requireString(
    definition.function?.name,
    `${label}.function.name`,
    MAX_IDENTITY_BYTES
  )
  const serverName = requireString(
    definition.server?.name,
    `${label}.server.name`,
    MAX_IDENTITY_BYTES
  )
  const originalName = requireString(
    definition.raw?.name ?? providerVisibleName,
    `${label}.originalName`,
    MAX_IDENTITY_BYTES
  )
  const binding =
    definition.source === 'mcp'
      ? {
          serverId: requireUuid(definition.server.id, `${label}.server.id`),
          configGeneration: requirePositiveSafeInteger(
            definition.server.configGeneration,
            `${label}.server.configGeneration`
          ),
          bindingHash: requireSha256(definition.server.bindingHash, `${label}.server.bindingHash`)
        }
      : normalizeOptionalAgentBinding(definition)

  return {
    target: {
      providerVisibleName,
      source: definition.source,
      serverName,
      ...binding,
      originalName
    },
    execution: normalizeExecution(definition.execution, `${label}.execution`)
  }
}

export function buildExecutionToolTargetKey(target: DeepChatExecutionToolTargetIdentity): string {
  return canonicalJsonStringifyData(target)
}

function normalizeToolCeilings(
  definitions: readonly MCPToolDefinition[]
): DeepChatExecutionToolCeiling[] {
  if (definitions.length > MAX_EXECUTION_CONTRACT_TOOLS) {
    throw new ExecutionContractError(
      `Execution contract has more than ${MAX_EXECUTION_CONTRACT_TOOLS} tools.`,
      'limit_exceeded'
    )
  }

  const ceilingByTarget = new Map<
    string,
    { ceiling: DeepChatExecutionToolCeiling; providerDefinitionHash: string }
  >()
  const targetKeyByVisibleName = new Map<string, string>()
  definitions.forEach((definition, index) => {
    const ceiling = normalizeToolCeiling(definition, index)
    const targetKey = buildExecutionToolTargetKey(ceiling.target)
    const providerDefinitionHash = buildProviderVisibleToolDefinitionsHash([definition])
    const visibleName = ceiling.target.providerVisibleName
    const previousTargetKey = targetKeyByVisibleName.get(visibleName)
    if (previousTargetKey !== undefined && previousTargetKey !== targetKey) {
      throw new ExecutionContractError(
        `Provider-visible tool ${visibleName} resolves to conflicting targets.`,
        'conflicting_tool'
      )
    }
    targetKeyByVisibleName.set(visibleName, targetKey)

    const previous = ceilingByTarget.get(targetKey)
    if (!previous) {
      ceilingByTarget.set(targetKey, { ceiling, providerDefinitionHash })
      return
    }
    if (
      previous.ceiling.execution.effect !== ceiling.execution.effect ||
      previous.ceiling.execution.mode !== ceiling.execution.mode
    ) {
      throw new ExecutionContractError(
        `Tool target ${visibleName} has conflicting execution policies.`,
        'conflicting_tool'
      )
    }
    if (previous.providerDefinitionHash !== providerDefinitionHash) {
      throw new ExecutionContractError(
        `Tool target ${visibleName} has conflicting provider definitions.`,
        'conflicting_tool'
      )
    }
  })

  return [...ceilingByTarget.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([, value]) => value.ceiling)
}

function normalizePromptSections(
  assembly: DeepChatPromptAssembly
): DeepChatPromptSectionProvenance[] {
  if (assembly.sections.length > MAX_EXECUTION_CONTRACT_PROMPT_SECTIONS) {
    throw new ExecutionContractError(
      `Execution contract has more than ${MAX_EXECUTION_CONTRACT_PROMPT_SECTIONS} prompt sections.`,
      'limit_exceeded'
    )
  }

  return assembly.sections.map((section, index) => {
    const label = `promptAssembly.sections[${index}]`
    if (!PROMPT_SECTION_KINDS.has(section.kind)) {
      throw new ExecutionContractError(`${label}.kind is invalid.`, 'invalid_input')
    }
    if (!PROMPT_SECTION_INCLUSIONS.has(section.inclusion)) {
      throw new ExecutionContractError(`${label}.inclusion is invalid.`, 'invalid_input')
    }
    const sourceRef = requireString(section.sourceRef, `${label}.sourceRef`, MAX_SOURCE_REF_BYTES)
    if (typeof section.content !== 'string') {
      throw new ExecutionContractError(`${label}.content must be a string.`, 'invalid_input')
    }
    if (section.degradationCodes !== undefined && !Array.isArray(section.degradationCodes)) {
      throw new ExecutionContractError(
        `${label}.degradationCodes must be an array.`,
        'invalid_input'
      )
    }
    if ((section.degradationCodes?.length ?? 0) > MAX_SECTION_DEGRADATION_CODES) {
      throw new ExecutionContractError(
        `${label} has more than ${MAX_SECTION_DEGRADATION_CODES} degradation codes.`,
        'limit_exceeded'
      )
    }
    const degradationCodes = [...new Set(section.degradationCodes ?? [])]
    if (degradationCodes.some((code) => !PROMPT_DEGRADATION_CODES.has(code))) {
      throw new ExecutionContractError(`${label}.degradationCodes is invalid.`, 'invalid_input')
    }
    degradationCodes.sort(compareCodePoints)
    if (section.freshness !== undefined && !PROMPT_SOURCE_FRESHNESS_VALUES.has(section.freshness)) {
      throw new ExecutionContractError(`${label}.freshness is invalid.`, 'invalid_input')
    }

    const hasContent = section.content.trim().length > 0
    const expectedInclusion = !hasContent
      ? 'omitted'
      : degradationCodes.length > 0
        ? 'degraded'
        : 'included'
    if (section.inclusion !== expectedInclusion) {
      throw new ExecutionContractError(
        `${label}.inclusion does not match its content and degradation state.`,
        'invalid_input'
      )
    }
    const contentHash = hasContent
      ? createHash('sha256').update(section.content, 'utf8').digest('hex')
      : undefined
    if (section.contentHash !== contentHash) {
      throw new ExecutionContractError(
        `${label}.contentHash does not match its content.`,
        'invalid_input'
      )
    }

    return {
      kind: section.kind,
      sourceRef,
      inclusion: section.inclusion,
      ...(contentHash ? { contentHash } : {}),
      ...(section.freshness ? { freshness: section.freshness } : {}),
      ...(degradationCodes.length > 0
        ? { degradationCodes: degradationCodes as DeepChatPromptDegradationCode[] }
        : {})
    }
  })
}

function normalizeRequest(
  request: DeepChatExecutionContractRequest
): DeepChatExecutionContractRequest {
  return {
    sessionId: requireString(request.sessionId, 'request.sessionId', MAX_IDENTITY_BYTES),
    messageId: requireString(request.messageId, 'request.messageId', MAX_IDENTITY_BYTES),
    runId: requireUuid(request.runId, 'request.runId'),
    requestSeq: requirePositiveSafeInteger(request.requestSeq, 'request.requestSeq')
  }
}

function normalizeWorkspace(
  workspace: DeepChatExecutionWorkspaceCeiling
): DeepChatExecutionWorkspaceCeiling {
  if (workspace?.kind === 'runtime_default') {
    return { kind: 'runtime_default' }
  }
  if (workspace?.kind !== 'path') {
    throw new ExecutionContractError('workspace.kind is invalid.', 'invalid_input')
  }
  const workspacePath = requireString(workspace.path, 'workspace.path', MAX_WORKSPACE_PATH_BYTES, {
    preserveOuterWhitespace: true
  })
  if (!path.isAbsolute(workspacePath)) {
    throw new ExecutionContractError('workspace.path must be absolute.', 'invalid_input')
  }
  return { kind: 'path', path: path.normalize(workspacePath) }
}

function normalizeMaxSubagentDepth(value: unknown): number {
  const depth = requireNonNegativeSafeInteger(value, 'maxSubagentDepth')
  if (depth > MAX_EXECUTION_CONTRACT_SUBAGENT_DEPTH) {
    throw new ExecutionContractError(
      `maxSubagentDepth exceeds the V1 limit of ${MAX_EXECUTION_CONTRACT_SUBAGENT_DEPTH}.`,
      'limit_exceeded'
    )
  }
  return depth
}

function normalizeDynamicControlSnapshot(
  snapshot: DeepChatExecutionDynamicControlSnapshot
): DeepChatExecutionDynamicControlSnapshot {
  if (!PERMISSION_MODES.has(snapshot?.permissionMode)) {
    throw new ExecutionContractError(
      'dynamicControlSnapshot.permissionMode is invalid.',
      'invalid_input'
    )
  }
  if (
    typeof snapshot.requestAdmitted !== 'boolean' ||
    typeof snapshot.cancellationRequested !== 'boolean'
  ) {
    throw new ExecutionContractError(
      'dynamicControlSnapshot admission and cancellation values must be boolean.',
      'invalid_input'
    )
  }
  return {
    permissionMode: snapshot.permissionMode,
    requestAdmitted: snapshot.requestAdmitted,
    cancellationRequested: snapshot.cancellationRequested
  }
}

function resolveLeadingSystemPrompt(messages: readonly ChatMessage[]): string {
  const first = messages[0]
  return first?.role === 'system' && typeof first.content === 'string' ? first.content : ''
}

export function buildEffectiveGenerationConfigHash(input: {
  modelConfig: ModelConfig
  temperature: number
  maxTokens: number
}): string {
  const modelConfig = Object.fromEntries(
    Object.entries(input.modelConfig).filter(([key]) => key !== 'conversationId')
  )
  return hashData(
    {
      modelConfig,
      temperature: requireFiniteNumber(input.temperature, 'temperature'),
      maxTokens: requirePositiveSafeInteger(input.maxTokens, 'maxTokens')
    },
    'generation config',
    true
  )
}

export function buildProviderVisibleToolDefinitionsHash(
  definitions: readonly MCPToolDefinition[]
): string {
  return hashData(
    definitions.map((definition) => stripToolExecutionContract(definition)),
    'provider-visible tool definitions',
    true
  )
}

export function isToolEffectWithinCeiling(effect: ToolEffect, ceiling: ToolEffect): boolean {
  if ((effect !== 'read' && effect !== 'write') || (ceiling !== 'read' && ceiling !== 'write')) {
    throw new ExecutionContractError('Tool effect is invalid.', 'invalid_input')
  }
  return effect === 'read' || ceiling === 'write'
}

export function meetToolEffects(left: ToolEffect, right: ToolEffect): ToolEffect {
  return isToolEffectWithinCeiling(left, right) ? left : right
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

function buildContractHash(contract: Omit<DeepChatExecutionContract, 'contractHash'>): string {
  return hashData(contract, 'execution contract')
}

export function buildExecutionContract(
  input: BuildExecutionContractInput
): DeepChatExecutionContract {
  if (input.promptAssembly.prompt !== resolveLeadingSystemPrompt(input.providerMessages)) {
    throw new ExecutionContractError(
      'Prompt assembly does not match the provider-visible system message.',
      'invalid_input'
    )
  }

  const tools = normalizeToolCeilings(input.tools)
  const ceilings = {
    tools,
    workspace: normalizeWorkspace(input.workspace),
    maxSubagentDepth: normalizeMaxSubagentDepth(input.maxSubagentDepth)
  }
  const draft: Omit<DeepChatExecutionContract, 'contractHash'> = {
    schemaVersion: DEEPCHAT_EXECUTION_CONTRACT_SCHEMA_VERSION,
    hashVersion: DEEPCHAT_EXECUTION_CONTRACT_HASH_VERSION,
    request: normalizeRequest(input.request),
    ceilings,
    dynamicControlSnapshot: normalizeDynamicControlSnapshot(input.dynamicControlSnapshot),
    provenance: {
      promptSections: normalizePromptSections(input.promptAssembly),
      providerId: requireString(input.providerId, 'providerId', MAX_IDENTITY_BYTES),
      modelId: requireString(input.modelId, 'modelId', MAX_IDENTITY_BYTES),
      promptHash: hashData(input.providerMessages, 'provider messages', true),
      effectiveGenerationConfigHash: buildEffectiveGenerationConfigHash(input),
      providerVisibleToolDefinitionsHash: buildProviderVisibleToolDefinitionsHash(input.tools),
      internalExecutionPolicyHash: hashData(ceilings, 'internal execution policy'),
      assemblerVersion: requireString(
        input.assemblerVersion,
        'assemblerVersion',
        MAX_ASSEMBLER_VERSION_BYTES
      ),
      taskContractRef: null
    }
  }
  const contract: DeepChatExecutionContract = {
    ...draft,
    contractHash: buildContractHash(draft)
  }
  const serialized = canonicalJsonStringifyData(contract)
  if (utf8Length(serialized) > MAX_EXECUTION_CONTRACT_BYTES) {
    throw new ExecutionContractError(
      `Execution contract exceeds ${MAX_EXECUTION_CONTRACT_BYTES} UTF-8 bytes.`,
      'limit_exceeded'
    )
  }
  return deepFreeze(contract)
}

export function verifyExecutionContractHash(contract: DeepChatExecutionContract): boolean {
  if (
    contract?.schemaVersion !== DEEPCHAT_EXECUTION_CONTRACT_SCHEMA_VERSION ||
    contract?.hashVersion !== DEEPCHAT_EXECUTION_CONTRACT_HASH_VERSION ||
    typeof contract.contractHash !== 'string' ||
    !SHA_256_PATTERN.test(contract.contractHash)
  ) {
    return false
  }
  try {
    const { contractHash, ...draft } = contract
    return buildContractHash(draft) === contractHash
  } catch {
    return false
  }
}
