import type {
  DeepChatEvaluationRef,
  DeepChatTaskAcceptanceRequirement,
  DeepChatTaskWorkspaceCeiling
} from '@shared/types/task-contract'

export const LIVE_DELEGATION_REQUIRED_RESULT_SECTIONS = [
  'Handoff',
  'Result',
  'Evidence',
  'Changed Files',
  'Validation',
  'Unresolved'
] as const

export interface LiveDelegationTaskContractInput {
  workspace: DeepChatTaskWorkspaceCeiling
  acceptance: readonly DeepChatTaskAcceptanceRequirement[]
  predecessorEvaluationRef: DeepChatEvaluationRef | null
  maxToolEffect: 'read' | 'write'
  maxSubagentDepth: number
}

export type LegacyLiveDelegationTaskContractInput = LiveDelegationTaskContractInput & {
  creationReason: 'legacy_recovery'
}

export function createLiveDelegationTaskContractInput(
  projectDir: string | null,
  predecessorEvaluationRef: DeepChatEvaluationRef | null = null
): LiveDelegationTaskContractInput {
  return {
    workspace: projectDir ? { kind: 'path', path: projectDir } : { kind: 'runtime_default' },
    acceptance: [
      {
        id: 'live-delegation-required-sections',
        kind: 'required_sections',
        level: 2,
        sections: LIVE_DELEGATION_REQUIRED_RESULT_SECTIONS
      }
    ],
    predecessorEvaluationRef,
    maxToolEffect: 'write',
    maxSubagentDepth: 0
  }
}

export function createLegacyLiveDelegationTaskContractInput(
  projectDir: string | null
): LegacyLiveDelegationTaskContractInput {
  return {
    ...createLiveDelegationTaskContractInput(projectDir),
    acceptance: [],
    creationReason: 'legacy_recovery'
  }
}
