import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEEPCHAT_TASK_EVALUATION_REASON_CODES,
  DeepChatTaskEvaluationProjectionSchema,
  DeepChatTaskEvaluationSummarySchema,
  MAX_TASK_EVALUATION_CANDIDATE_BYTES,
  type DeepChatHandoffFormatRequirement,
  type DeepChatTaskEvaluationExecutionStatus
} from '@shared/types/task-contract'
import { hashJsonData } from '@/tape/domain/canonicalJson'
import { buildTaskContract } from '@/tape/domain/taskContract'
import {
  buildTaskEvaluation,
  projectTaskEvaluationSummary,
  restoreTaskEvaluation,
  serializeTaskEvaluation
} from '@/tape/domain/taskEvaluation'

const DEFAULT_HANDOFF_FORMAT: readonly DeepChatHandoffFormatRequirement[] = [
  {
    id: 'sections',
    kind: 'required_sections',
    level: 2,
    sections: ['Handoff', 'Validation']
  }
]

function createContract(
  handoffFormat: readonly DeepChatHandoffFormatRequirement[] = DEFAULT_HANDOFF_FORMAT
) {
  return buildTaskContract({
    delegationId: 'delegation-1',
    turnId: 'turn-1',
    turnSeq: 1,
    turnKind: 'initial',
    parentSessionId: 'parent-1',
    slotId: 'reviewer',
    targetAgentId: 'agent-1',
    title: 'Review boundaries',
    prompt: 'Inspect the contract boundary.',
    workspace: { kind: 'path', path: path.resolve('project') },
    handoffFormat,
    predecessorEvaluationRef: null,
    maxToolEffect: 'write',
    maxSubagentDepth: 0
  })
}

function evaluate(
  candidateResult: string | null,
  executionStatus: DeepChatTaskEvaluationExecutionStatus = 'completed',
  handoffFormat: readonly DeepChatHandoffFormatRequirement[] = DEFAULT_HANDOFF_FORMAT
) {
  return buildTaskEvaluation({
    contract: createContract(handoffFormat),
    executionStatus,
    candidateResult
  })
}

describe('Task evaluation domain', () => {
  it('validates required Handoff sections without treating their contents as task success', () => {
    const candidate = [
      '```markdown',
      '## Handoff',
      'This heading is fenced and must not count.',
      '```',
      '## Handoff',
      'This claim is untrusted task evidence.',
      '## Validation',
      'The required section has a body.'
    ].join('\n')

    const first = evaluate(candidate)
    const second = evaluate(candidate)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      evaluatorVersion: 'handoff-format-v1',
      evaluationKind: 'handoff_format',
      formatStatus: 'valid',
      reasonCodes: [],
      records: [{ requirementId: 'sections', code: 'required_sections_present', outcome: 'valid' }]
    })
    expect(first).not.toHaveProperty('verdict')
    expect(first).not.toHaveProperty('disposition')
    expect(first.evaluationHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(Object.isFrozen(first)).toBe(true)
    expect(restoreTaskEvaluation(JSON.parse(serializeTaskEvaluation(first)))).toEqual(first)

    const mutableRef = {
      schemaVersion: 1,
      sessionId: 'parent-1',
      tapeIdentity: 'a'.repeat(64),
      entryId: 3,
      evaluationHash: first.evaluationHash
    } as const
    const summary = projectTaskEvaluationSummary(first, mutableRef)
    expect(summary).toMatchObject({
      evaluationKind: 'handoff_format',
      formatStatus: 'valid',
      evidence: [],
      omittedEvidenceCount: 0
    })
    expect(summary.evaluationRef).not.toBe(mutableRef)
    expect(Object.isFrozen(mutableRef)).toBe(false)
  })

  it('reports every missing section as bounded format evidence', () => {
    const result = evaluate(['## Handoff', 'Review complete.'].join('\n'), 'completed')

    expect(result).toMatchObject({
      formatStatus: 'invalid',
      reasonCodes: ['required_sections_missing']
    })
    expect(result.records).toEqual([
      expect.objectContaining({
        requirementId: 'sections',
        code: 'required_sections_missing',
        section: 'Validation'
      })
    ])
    expect(
      projectTaskEvaluationSummary(
        result,
        {
          schemaVersion: 1,
          sessionId: 'parent-1',
          tapeIdentity: 'b'.repeat(64),
          entryId: 4,
          evaluationHash: result.evaluationHash
        },
        1
      )
    ).toMatchObject({
      evidence: [expect.objectContaining({ requirementId: 'sections' })],
      omittedEvidenceCount: 0
    })
  })

  it('keeps format validity independent from execution failure', () => {
    const result = evaluate('## Handoff\nDone.\n## Validation\nChecked.', 'failed')

    expect(result).toMatchObject({
      executionStatus: 'failed',
      formatStatus: 'valid',
      reasonCodes: []
    })
  })

  it.each([
    {
      name: 'a missing section',
      candidate: '## Handoff\nDone.',
      section: 'Validation'
    },
    {
      name: 'an empty section',
      candidate: '## Handoff\nDone.\n## Validation\n\n',
      section: 'Validation'
    }
  ])('marks a completed candidate invalid with $name', ({ candidate, section }) => {
    const result = evaluate(candidate)

    expect(result).toMatchObject({ formatStatus: 'invalid' })
    expect(result.records[0]).toMatchObject({ code: 'required_sections_missing', section })
  })

  it.each([
    { status: 'cancelled' as const, candidate: 'answer', code: 'execution_cancelled' },
    { status: 'interrupted' as const, candidate: 'answer', code: 'execution_interrupted' },
    { status: 'completed' as const, candidate: null, code: 'candidate_missing' },
    {
      status: 'completed' as const,
      candidate: 'x'.repeat(MAX_TASK_EVALUATION_CANDIDATE_BYTES + 1),
      code: 'candidate_too_large'
    }
  ])('records $code as indeterminate', ({ status, candidate, code }) => {
    expect(evaluate(candidate, status)).toMatchObject({
      formatStatus: 'indeterminate',
      reasonCodes: [code],
      records: [{ code, outcome: 'indeterminate' }]
    })
  })

  it('rejects hash-valid projections that violate canonical reason evidence', () => {
    const evaluation = evaluate('## Handoff\nDone.\n## Validation\nChecked.')
    const { evaluationHash: _evaluationHash, ...draft } = evaluation
    const forgedDraft = {
      ...draft,
      formatStatus: 'invalid' as const,
      reasonCodes: ['candidate_missing' as const]
    }
    const forged = { ...forgedDraft, evaluationHash: hashJsonData(forgedDraft) }

    expect(restoreTaskEvaluation(forged)).toBeNull()
  })

  it('bounds reason-code arrays in full and parent-facing projections', () => {
    const evaluation = evaluate(null)
    const evaluationRef = {
      schemaVersion: 1 as const,
      sessionId: 'parent-1',
      tapeIdentity: 'a'.repeat(64),
      entryId: 1,
      evaluationHash: evaluation.evaluationHash
    }
    const summary = projectTaskEvaluationSummary(evaluation, evaluationRef)
    const reasonCodes = Array.from(
      { length: DEEPCHAT_TASK_EVALUATION_REASON_CODES.length + 1 },
      () => 'candidate_missing' as const
    )

    expect(
      DeepChatTaskEvaluationProjectionSchema.safeParse({ ...evaluation, reasonCodes }).success
    ).toBe(false)
    expect(DeepChatTaskEvaluationSummarySchema.safeParse({ ...summary, reasonCodes }).success).toBe(
      false
    )
  })
})
