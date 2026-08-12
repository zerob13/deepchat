import { types as nodeTypes } from 'node:util'
import type { DeepChatToolProfileKind } from '@/agent/deepchat/instance/deepChatAgentInstance'
import type { LoopRunToolSurfaceMode } from '@/agent/deepchat/loop/loopRun'
import type { ChatMessage } from '@shared/types/core/chat-message'
import type {
  CanonicalToolCatalog,
  ToolSurfaceDefinitionIdentity,
  ToolSurfaceSelectionPolicy
} from './toolSurface'

const MAX_RECENT_MESSAGES = 64
const MAX_RECENT_TOOL_NAMES = 64
const MAX_RECENT_TOOL_CALLS_INSPECTED = 256
const MAX_RECENT_TOOL_NAME_CODE_UNITS = 1_024
const MAX_RECENT_TOOL_NAME_BYTES = 1_024

const TOOL_SURFACE_SELECTION_BOUNDS = Object.freeze({
  maxInitialToolCount: 32,
  maxInitialDefinitionTokens: 10_000,
  activationReserveToolCount: 8,
  activationReserveDefinitionTokens: 2_000,
  maxActivationCandidatesPerBatch: 16,
  maxActivationCandidateDefinitionTokensPerBatch: 2_000,
  maxActivationBatchesPerRun: 8,
  maxAppendedTargetsPerRun: 8,
  toolSearchPromptTokens: 128
})

const CODE_CORE_TOOL_NAMES = Object.freeze([
  'deepchat_question',
  'edit',
  'exec',
  'glob',
  'grep',
  'process',
  'read',
  'update_plan',
  'write'
])
const GENERAL_CORE_TOOL_NAMES = Object.freeze(['deepchat_question', 'update_plan'])

export interface ToolSurfacePolicySelectionInputs {
  readonly policyRequiredStableTargetKeys: readonly string[]
  readonly coreStableTargetKeys: readonly string[]
  readonly activeSkillRequiredStableTargetKeys: readonly string[]
  readonly recentHints: readonly ToolSurfaceDefinitionIdentity[]
}

export interface AutomaticToolSurfaceRunModeAssignment {
  readonly mode: 'automatic'
  /** A trusted rollout result backed by measured provider/model evidence, never an inference. */
  readonly cliProgrammaticCapability: 'proven' | 'unproven'
  /** Cross-Run hysteresis hint only. Current Run facts remain authoritative. */
  readonly previouslyVirtualized?: boolean
}

export type ToolSurfaceRunModeAssignment =
  | LoopRunToolSurfaceMode
  | AutomaticToolSurfaceRunModeAssignment

export function isAutomaticToolSurfaceRunModeAssignment(
  assignment: ToolSurfaceRunModeAssignment
): assignment is AutomaticToolSurfaceRunModeAssignment {
  return (
    typeof assignment === 'object' &&
    assignment !== null &&
    assignment.mode === 'automatic' &&
    (assignment.cliProgrammaticCapability === 'proven' ||
      assignment.cliProgrammaticCapability === 'unproven') &&
    (assignment.previouslyVirtualized === undefined ||
      typeof assignment.previouslyVirtualized === 'boolean')
  )
}

export function selectAutomaticToolSurfaceRunMode(input: {
  readonly virtualizationTriggered: boolean
  readonly cliProgrammaticCapability: 'proven' | 'unproven'
  readonly agentExecAvailable: boolean
  readonly programmaticRunCeilingFits: boolean
}): Exclude<LoopRunToolSurfaceMode, 'legacy'> {
  if (!input.virtualizationTriggered) return 'full'
  return input.cliProgrammaticCapability === 'proven' &&
    input.agentExecAvailable &&
    input.programmaticRunCeilingFits
    ? 'cli-programmatic'
    : 'native-activation'
}

export function createAutomaticToolSurfaceSelectionPolicy(
  toolSearchDefinitionTokens: number
): ToolSurfaceSelectionPolicy {
  return Object.freeze({
    policyVersion: 'automatic-adapter-v1',
    enterToolCount: 40,
    exitToolCount: 32,
    enterEstimatedInputTokens: 12_000,
    exitEstimatedInputTokens: 9_600,
    ...TOOL_SURFACE_SELECTION_BOUNDS,
    toolSearchDefinitionTokens
  })
}

export function createExplicitNativeActivationPolicy(
  toolSearchDefinitionTokens: number
): ToolSurfaceSelectionPolicy {
  return Object.freeze({
    policyVersion: 'native-activation-explicit-v1',
    enterToolCount: 1,
    exitToolCount: 0,
    enterEstimatedInputTokens: 1,
    exitEstimatedInputTokens: 0,
    ...TOOL_SURFACE_SELECTION_BOUNDS,
    toolSearchDefinitionTokens
  })
}

function coreToolNames(profile: DeepChatToolProfileKind): readonly string[] {
  switch (profile) {
    case 'code':
      return CODE_CORE_TOOL_NAMES
    case 'research':
    case 'analysis':
    case 'general':
      return GENERAL_CORE_TOOL_NAMES
  }
}

function stableTargetKeysForVisibleNames(
  catalog: CanonicalToolCatalog,
  names: readonly string[]
): string[] {
  const entryByName = new Map(
    catalog.entries.map((entry) => [entry.target.providerVisibleName, entry.stableTargetKey])
  )
  const stableTargetKeys: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const stableTargetKey = entryByName.get(name)
    if (!stableTargetKey || seen.has(stableTargetKey)) continue
    seen.add(stableTargetKey)
    stableTargetKeys.push(stableTargetKey)
  }
  return stableTargetKeys
}

function isSafeDataObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readOwnDataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function readSafeArrayElement(value: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function isBoundedRecentToolName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RECENT_TOOL_NAME_CODE_UNITS &&
    value === value.trim() &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_RECENT_TOOL_NAME_BYTES
  )
}

export function collectRecentToolSurfaceNames(
  messages: readonly ChatMessage[]
): readonly string[] {
  if (!Array.isArray(messages) || nodeTypes.isProxy(messages)) return Object.freeze([])
  const names: string[] = []
  const seen = new Set<string>()
  let inspectedToolCalls = 0
  const firstIndex = Math.max(0, messages.length - MAX_RECENT_MESSAGES)
  for (let messageIndex = messages.length - 1; messageIndex >= firstIndex; messageIndex -= 1) {
    const message = readSafeArrayElement(messages, messageIndex)
    if (!isSafeDataObject(message) || readOwnDataProperty(message, 'role') !== 'assistant') continue
    const toolCalls = readOwnDataProperty(message, 'tool_calls')
    if (!Array.isArray(toolCalls) || nodeTypes.isProxy(toolCalls)) continue
    for (let callIndex = toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      inspectedToolCalls += 1
      if (inspectedToolCalls > MAX_RECENT_TOOL_CALLS_INSPECTED) return Object.freeze(names)
      const call = readSafeArrayElement(toolCalls, callIndex)
      if (!isSafeDataObject(call)) continue
      const functionCall = readOwnDataProperty(call, 'function')
      if (!isSafeDataObject(functionCall)) continue
      const name = readOwnDataProperty(functionCall, 'name')
      if (!isBoundedRecentToolName(name) || seen.has(name)) continue
      seen.add(name)
      names.push(name)
      if (names.length >= MAX_RECENT_TOOL_NAMES) return Object.freeze(names)
    }
  }
  return Object.freeze(names)
}

export function prepareToolSurfacePolicySelectionInputs(input: {
  readonly eligibleCatalog: CanonicalToolCatalog
  readonly toolProfile: DeepChatToolProfileKind
  readonly activeSkillRequiredStableTargetKeys: readonly string[]
  readonly recentToolNames: readonly string[]
}): ToolSurfacePolicySelectionInputs {
  const policyRequiredStableTargetKeys = input.eligibleCatalog.entries
    .filter((entry) => entry.exposure === 'system-model')
    .map((entry) => entry.stableTargetKey)
  const coreStableTargetKeys = stableTargetKeysForVisibleNames(
    input.eligibleCatalog,
    coreToolNames(input.toolProfile)
  )
  const recentStableTargetKeys = stableTargetKeysForVisibleNames(
    input.eligibleCatalog,
    input.recentToolNames
  )
  const eligibleIdentityByTarget = new Map(
    input.eligibleCatalog.entries.map((entry) => [
      entry.stableTargetKey,
      {
        stableTargetKey: entry.stableTargetKey,
        canonicalToolDefinitionHash: entry.canonicalToolDefinitionHash
      }
    ])
  )
  return Object.freeze({
    policyRequiredStableTargetKeys: Object.freeze(policyRequiredStableTargetKeys),
    coreStableTargetKeys: Object.freeze(coreStableTargetKeys),
    activeSkillRequiredStableTargetKeys: Object.freeze([
      ...input.activeSkillRequiredStableTargetKeys
    ]),
    recentHints: Object.freeze(
      recentStableTargetKeys.flatMap((stableTargetKey) => {
        const identity = eligibleIdentityByTarget.get(stableTargetKey)
        return identity ? [Object.freeze(identity)] : []
      })
    )
  })
}
