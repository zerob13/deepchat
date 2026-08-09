import path from 'node:path'
import Ajv from 'ajv'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_TASK_EVALUATION_CANDIDATE_BYTES,
  type DeepChatTaskAcceptanceRequirement,
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

const DEFAULT_ACCEPTANCE: readonly DeepChatTaskAcceptanceRequirement[] = [
  {
    id: 'sections',
    kind: 'required_sections',
    level: 2,
    sections: ['Handoff', 'Validation']
  },
  {
    id: 'result',
    kind: 'result_schema',
    section: 'Result',
    schema: {
      type: 'object',
      properties: { decision: { type: 'string' } },
      required: ['decision'],
      additionalProperties: false
    }
  }
]

function createContract(
  acceptance: readonly DeepChatTaskAcceptanceRequirement[] = DEFAULT_ACCEPTANCE
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
    acceptance,
    predecessorEvaluationRef: null,
    maxToolEffect: 'write',
    maxSubagentDepth: 0
  })
}

function evaluate(
  candidateResult: string | null,
  executionStatus: DeepChatTaskEvaluationExecutionStatus = 'completed',
  acceptance: readonly DeepChatTaskAcceptanceRequirement[] = DEFAULT_ACCEPTANCE
) {
  return buildTaskEvaluation({
    contract: createContract(acceptance),
    executionStatus,
    candidateResult
  })
}

describe('Task evaluation domain', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('evaluates required sections and one fenced JSON result as a canonical pass', () => {
    const candidate = [
      '```markdown',
      '## Handoff',
      'This heading is fenced and must not count.',
      '```',
      '## Handoff',
      'Use the reviewed result.',
      '## Result',
      '```json',
      '{"decision":"accept"}',
      '```',
      '## Validation',
      'Focused tests passed.'
    ].join('\n')

    const first = evaluate(candidate)
    const second = evaluate(candidate)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      verdict: 'passed',
      disposition: 'accepted',
      reasonCodes: [],
      records: [
        { requirementId: 'result', code: 'result_schema_valid', outcome: 'passed' },
        { requirementId: 'sections', code: 'required_sections_present', outcome: 'passed' }
      ]
    })
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
      verdict: 'passed',
      disposition: 'accepted',
      evidence: [],
      omittedEvidenceCount: 0
    })
    expect(summary.evaluationRef).not.toBe(mutableRef)
    expect(Object.isFrozen(mutableRef)).toBe(false)
  })

  it('lets a definite requirement failure win over an evaluator failure', () => {
    const result = evaluate(
      ['## Handoff', 'Review complete.', '## Result', '{"value":"aaaa"}'].join('\n'),
      'completed',
      [
        {
          id: 'schema',
          kind: 'result_schema',
          section: 'Result',
          schema: { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+$' } } }
        },
        {
          id: 'sections',
          kind: 'required_sections',
          level: 2,
          sections: ['Handoff', 'Validation']
        }
      ]
    )

    expect(result).toMatchObject({
      verdict: 'failed',
      disposition: 'parked',
      reasonCodes: ['evaluator_error', 'required_sections_missing']
    })
    expect(result.records).toEqual([
      expect.objectContaining({ requirementId: 'schema', code: 'evaluator_error' }),
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
      evidence: [expect.objectContaining({ requirementId: 'schema' })],
      omittedEvidenceCount: 1
    })
  })

  it.each([
    {
      name: 'an asynchronous validator',
      validate: Object.assign(
        vi.fn(async () => {
          throw new Error('must not run')
        }),
        { $async: true as const }
      ),
      expectedCalls: 0
    },
    {
      name: 'a validator returning a non-boolean value',
      validate: vi.fn(() => Promise.resolve(true)),
      expectedCalls: 1
    }
  ])('records evaluator_error for $name', ({ validate, expectedCalls }) => {
    vi.spyOn(Ajv.prototype, 'compile').mockReturnValue(validate as never)

    const result = evaluate('## Result\n{}', 'completed', [
      { id: 'result', kind: 'result_schema', section: 'Result', schema: {} }
    ])

    expect(result).toMatchObject({
      verdict: 'indeterminate',
      disposition: 'parked',
      reasonCodes: ['evaluator_error'],
      records: [{ code: 'evaluator_error', outcome: 'indeterminate' }]
    })
    expect(validate).toHaveBeenCalledTimes(expectedCalls)
  })

  it('keeps a valid contract verdict independent from execution failure', () => {
    const result = evaluate(
      '## Handoff\nDone.\n## Result\n{"decision":"accept"}\n## Validation\nChecked.',
      'failed'
    )

    expect(result).toMatchObject({
      executionStatus: 'failed',
      verdict: 'passed',
      disposition: 'accepted',
      reasonCodes: []
    })
  })

  it('does not interpret JSON Schema const data as executable pattern syntax', () => {
    const result = evaluate('## Result\n{"metadata":{"pattern":"(a+)+$"}}', 'completed', [
      {
        id: 'result',
        kind: 'result_schema',
        section: 'Result',
        schema: {
          type: 'object',
          properties: { metadata: { const: { pattern: '(a+)+$' } } },
          required: ['metadata']
        }
      }
    ])

    expect(result).toMatchObject({
      verdict: 'passed',
      disposition: 'accepted',
      reasonCodes: []
    })
  })

  it.each([
    {
      name: 'missing result section',
      candidate: '## Handoff\nDone.\n## Validation\nChecked.',
      code: 'result_section_missing',
      keyword: null
    },
    {
      name: 'malformed result JSON',
      candidate: '## Handoff\nDone.\n## Result\n{nope}\n## Validation\nChecked.',
      code: 'result_json_invalid',
      keyword: null
    },
    {
      name: 'schema mismatch',
      candidate: '## Handoff\nDone.\n## Result\n{}\n## Validation\nChecked.',
      code: 'result_schema_mismatch',
      keyword: 'required'
    }
  ])('parks a completed candidate with $name', ({ candidate, code, keyword }) => {
    const result = evaluate(candidate)

    expect(result).toMatchObject({ verdict: 'failed', disposition: 'parked' })
    expect(result.records[0]).toMatchObject({ code, keyword })
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
      verdict: 'indeterminate',
      disposition: 'parked',
      reasonCodes: [code],
      records: [{ code, outcome: 'indeterminate' }]
    })
  })

  it('bounds parsed candidate structure before schema validation', () => {
    const nested = `${'['.repeat(66)}0${']'.repeat(66)}`
    const result = evaluate(`## Result\n${nested}`, 'completed', [
      { id: 'result', kind: 'result_schema', section: 'Result', schema: {} }
    ])

    expect(result).toMatchObject({
      verdict: 'indeterminate',
      disposition: 'parked',
      reasonCodes: ['candidate_too_complex']
    })
  })

  it('rejects hash-valid projections that violate canonical reason evidence', () => {
    const evaluation = evaluate(
      '## Handoff\nDone.\n## Result\n{"decision":"accept"}\n## Validation\nChecked.'
    )
    const { evaluationHash: _evaluationHash, ...draft } = evaluation
    const forgedDraft = {
      ...draft,
      verdict: 'failed' as const,
      disposition: 'parked' as const,
      reasonCodes: ['candidate_missing' as const]
    }
    const forged = { ...forgedDraft, evaluationHash: hashJsonData(forgedDraft) }

    expect(restoreTaskEvaluation(forged)).toBeNull()
  })
})
