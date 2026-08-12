import type { AppSessionId } from '@/agent/shared/agentSessionIds'
import type { ChatMessage } from '@shared/types/core/chat-message'
import type { MCPToolDefinition } from '@shared/types/core/mcp'
import type { DeepChatPromptAssembly } from '@shared/types/prompt-assembly'
import type { DeepChatExecutionContract } from '@shared/types/execution-contract'
import { ResolvedCommandShellSchema, type ResolvedCommandShell } from '@shared/commandShell'
import {
  assertIssuedToolSurfaceSnapshot,
  revokeToolSurfaceExecutionEligibility,
  type ToolSurfaceActivationEvidence,
  type ToolSurfaceSnapshot
} from '@/agent/deepchat/runtime/toolSurface'
import {
  assertProgrammaticToolCapabilityViewPrepared,
  type ProgrammaticToolCapabilityV1
} from '@/agent/deepchat/runtime/programmaticToolSurface'

export type LoopRunToolSurfaceMode = 'legacy' | 'full' | 'native-activation' | 'cli-programmatic'

export interface LoopRunResources {
  toolDefinitions: MCPToolDefinition[]
  activeSkillNames: string[]
  promptAssembly?: DeepChatPromptAssembly
  commandShell: ResolvedCommandShell
  readonly toolSurfaceMode: LoopRunToolSurfaceMode
}

export interface LoopRunProviderRecovery {
  contextOverflowHandoffAttempted: boolean
  strictProviderOverflowRetryUsed: boolean
}

export interface LoopRunRequestContractBinding {
  readonly requestSeq: number
  readonly executionContract: DeepChatExecutionContract | null
}

export interface LoopRunRequestToolSurfaceBinding {
  readonly requestSeq: number
  readonly snapshot: ToolSurfaceSnapshot
  readonly programmaticCapability?: ProgrammaticToolCapabilityV1
  readonly releaseActivationCandidates: (
    candidates: readonly ToolSurfaceActivationEvidence[]
  ) => void
}

export interface LoopRun<TStreamState> {
  readonly runId: string
  readonly sessionId: AppSessionId
  readonly messageId: string
  readonly abortController: AbortController
  readonly startedAt: number
  readonly initialRequestSeq: number
  logicalRound: number
  requestSeq: number
  physicalAttempt: number
  messages: ChatMessage[]
  readonly streamState: TStreamState
  resources: LoopRunResources
  providerRecovery: LoopRunProviderRecovery
  activeRequestContract: LoopRunRequestContractBinding | null
  activeRequestToolSurface: LoopRunRequestToolSurfaceBinding | null
}

export interface CreateLoopRunInput<TStreamState> {
  runId: string
  sessionId: AppSessionId
  messageId: string
  abortController: AbortController
  messages: readonly ChatMessage[]
  streamState: TStreamState
  resources: {
    toolDefinitions: readonly MCPToolDefinition[]
    activeSkillNames: readonly string[]
    promptAssembly?: DeepChatPromptAssembly
    commandShell: ResolvedCommandShell
    toolSurfaceMode?: LoopRunToolSurfaceMode
  }
  initialRequestSeq?: number
  initialLogicalRound?: number
  startedAt?: number
}

function normalizeInitialCounter(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function createLoopRun<TStreamState>(
  input: CreateLoopRunInput<TStreamState>
): LoopRun<TStreamState> {
  const initialRequestSeq = normalizeInitialCounter(input.initialRequestSeq)
  const parsedCommandShell = ResolvedCommandShellSchema.parse(input.resources.commandShell)
  const commandShell = Object.freeze({
    ...parsedCommandShell,
    args: Object.freeze([...parsedCommandShell.args])
  }) as ResolvedCommandShell
  const resources: LoopRunResources = {
    toolDefinitions: [...input.resources.toolDefinitions],
    activeSkillNames: [...input.resources.activeSkillNames],
    ...(input.resources.promptAssembly ? { promptAssembly: input.resources.promptAssembly } : {}),
    commandShell,
    toolSurfaceMode: input.resources.toolSurfaceMode ?? 'legacy'
  }
  Object.defineProperty(resources, 'toolSurfaceMode', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: resources.toolSurfaceMode
  })
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    abortController: input.abortController,
    startedAt: input.startedAt ?? Date.now(),
    initialRequestSeq,
    logicalRound: normalizeInitialCounter(input.initialLogicalRound),
    requestSeq: initialRequestSeq,
    physicalAttempt: 0,
    messages: [...input.messages],
    streamState: input.streamState,
    resources,
    providerRecovery: {
      contextOverflowHandoffAttempted: false,
      strictProviderOverflowRetryUsed: false
    },
    activeRequestContract: null,
    activeRequestToolSurface: null
  }
}

export function enterLogicalRound(run: LoopRun<unknown>): number {
  const nextLogicalRound = run.logicalRound + 1
  if (!Number.isSafeInteger(nextLogicalRound) || nextLogicalRound <= 0) {
    throw new Error('Provider logical round counter is exhausted.')
  }
  run.logicalRound = nextLogicalRound
  return nextLogicalRound
}

export function advanceRequestSequence(run: LoopRun<unknown>): number {
  const nextRequestSeq = run.requestSeq + 1
  if (!Number.isSafeInteger(nextRequestSeq) || nextRequestSeq <= 0) {
    throw new Error('Provider request sequence is exhausted.')
  }
  revokeActiveRequestToolSurface(run)
  run.requestSeq = nextRequestSeq
  run.physicalAttempt = 0
  run.activeRequestContract = null
  return nextRequestSeq
}

export function revokeActiveRequestToolSurface(run: LoopRun<unknown>): void {
  const binding = run.activeRequestToolSurface
  if (!binding) return
  revokeToolSurfaceExecutionEligibility(binding.snapshot)
  run.activeRequestToolSurface = null
}

export function bindActiveRequestContract(
  run: LoopRun<unknown>,
  requestSeq: number,
  executionContract: DeepChatExecutionContract | null
): LoopRunRequestContractBinding {
  if (requestSeq !== run.requestSeq) {
    throw new Error('Execution contract request sequence does not match the active request.')
  }
  if (
    executionContract &&
    (executionContract.request.sessionId !== run.sessionId ||
      executionContract.request.messageId !== run.messageId ||
      executionContract.request.runId !== run.runId ||
      executionContract.request.requestSeq !== requestSeq)
  ) {
    throw new Error('Execution contract identity does not match the active Loop Run.')
  }
  const binding = Object.freeze({ requestSeq, executionContract })
  run.activeRequestContract = binding
  return binding
}

export function bindActiveRequestToolSurface(
  run: LoopRun<unknown>,
  requestSeq: number,
  snapshot: ToolSurfaceSnapshot,
  releaseActivationCandidates: (candidates: readonly ToolSurfaceActivationEvidence[]) => void,
  programmaticCapability: ProgrammaticToolCapabilityV1 | null = null
): LoopRunRequestToolSurfaceBinding {
  if (requestSeq !== run.requestSeq) {
    throw new Error('Tool Surface request sequence does not match the active request.')
  }
  assertIssuedToolSurfaceSnapshot(snapshot)
  if (
    snapshot.request.sessionId !== run.sessionId ||
    snapshot.request.messageId !== run.messageId ||
    snapshot.request.runId !== run.runId ||
    snapshot.request.requestSeq !== requestSeq
  ) {
    throw new Error('Tool Surface identity does not match the active Loop Run.')
  }
  if (typeof releaseActivationCandidates !== 'function') {
    throw new Error('Tool Surface activation release capability is unavailable.')
  }
  if (snapshot.adapterMode === 'cli-programmatic') {
    if (programmaticCapability !== null) {
      assertProgrammaticToolCapabilityViewPrepared(programmaticCapability, snapshot)
    }
  } else if (programmaticCapability !== null) {
    throw new Error('A non-programmatic Tool Surface cannot bind a Programmatic capability.')
  }
  const binding = Object.freeze({
    requestSeq,
    snapshot,
    ...(programmaticCapability ? { programmaticCapability } : {}),
    releaseActivationCandidates
  })
  run.activeRequestToolSurface = binding
  return binding
}

export function enterPhysicalAttempt(run: LoopRun<unknown>): number {
  if (!Number.isSafeInteger(run.requestSeq) || run.requestSeq <= 0) {
    throw new Error('Provider request sequence must be started before a physical attempt.')
  }
  const nextPhysicalAttempt = run.physicalAttempt + 1
  if (!Number.isSafeInteger(nextPhysicalAttempt) || nextPhysicalAttempt <= 0) {
    throw new Error('Provider physical attempt counter is exhausted.')
  }
  run.physicalAttempt = nextPhysicalAttempt
  return nextPhysicalAttempt
}
