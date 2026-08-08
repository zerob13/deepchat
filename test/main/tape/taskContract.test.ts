import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_TASK_CONTRACT_REQUIREMENTS,
  type DeepChatTaskAcceptanceRequirement
} from '@shared/types/task-contract'
import type { JsonValue } from '@shared/contracts/json'
import {
  TaskContractError,
  buildTaskContract,
  isDeepChatTaskContract,
  restoreTaskContract,
  restoreTaskContractRef,
  serializeTaskContract,
  serializeTaskContractRef,
  type BuildTaskContractInput
} from '@/tape/domain/taskContract'

const TEST_WORKSPACE_PATH = path.resolve('project scope ')

function buildInput(overrides: Partial<BuildTaskContractInput> = {}): BuildTaskContractInput {
  return {
    delegationId: 'delegation-1',
    turnId: 'turn-1',
    turnSeq: 1,
    turnKind: 'initial',
    parentSessionId: 'parent-1',
    slotId: 'reviewer',
    targetAgentId: 'agent-1',
    title: 'Review boundaries',
    prompt: 'Inspect the contract boundary.',
    workspace: { kind: 'path', path: TEST_WORKSPACE_PATH },
    acceptance: [
      {
        id: 'sections',
        kind: 'required_sections',
        level: 2,
        sections: ['Validation', 'Handoff']
      },
      {
        id: 'result',
        kind: 'result_schema',
        section: 'Result',
        schema: {
          required: ['decision'],
          properties: { decision: { type: 'string' } },
          type: 'object'
        }
      }
    ],
    predecessorEvaluationRef: null,
    maxToolEffect: 'write',
    maxSubagentDepth: 0,
    ...overrides
  }
}

describe('TaskContract domain', () => {
  it('canonicalizes semantically unordered inputs into one immutable identity', () => {
    const first = buildTaskContract(buildInput())
    const second = buildTaskContract(
      buildInput({
        acceptance: [
          {
            id: 'result',
            kind: 'result_schema',
            section: 'Result',
            schema: {
              type: 'object',
              properties: { decision: { type: 'string' } },
              required: ['decision']
            }
          },
          {
            id: 'sections',
            kind: 'required_sections',
            level: 2,
            sections: ['Handoff', 'Validation']
          }
        ]
      })
    )

    expect(first).toEqual(second)
    expect(first.contractHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.taskHarness.acceptance.map((requirement) => requirement.id)).toEqual([
      'result',
      'sections'
    ])
    expect(first.taskHarness.ceilings.workspace).toEqual({
      kind: 'path',
      path: TEST_WORKSPACE_PATH
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.taskHarness.acceptance)).toBe(true)
    expect(isDeepChatTaskContract(JSON.parse(serializeTaskContract(first)))).toBe(true)
  })

  it('detects content and hash tampering during recovery', () => {
    const contract = buildTaskContract(buildInput())
    const tampered = {
      ...contract,
      taskDescription: { ...contract.taskDescription, title: 'Different task' }
    }

    expect(isDeepChatTaskContract(tampered)).toBe(false)
    expect(restoreTaskContract(tampered)).toBeNull()
    expect(restoreTaskContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract)
    expect(() =>
      buildTaskContract(buildInput({ creationReason: 'unknown' as 'delegation_created' }))
    ).toThrow(/creationReason is invalid/u)
  })

  it('keeps canonical workspace paths portable across host platforms', () => {
    const contract = buildTaskContract(
      buildInput({ workspace: { kind: 'path', path: 'C:/workspace/project/' } })
    )

    expect(contract.taskHarness.ceilings.workspace).toEqual({
      kind: 'path',
      path: 'C:\\workspace\\project\\'
    })
    expect(restoreTaskContract(JSON.parse(serializeTaskContract(contract)))).toEqual(contract)
  })

  it('rejects predecessor evaluations from another parent Session', () => {
    const predecessorEvaluationRef = {
      schemaVersion: 1 as const,
      sessionId: 'parent-1',
      tapeIdentity: 'a'.repeat(64),
      entryId: 3,
      evaluationHash: 'b'.repeat(64)
    }

    expect(
      buildTaskContract(buildInput({ turnKind: 'follow_up', turnSeq: 2, predecessorEvaluationRef }))
        .taskConfig.predecessorEvaluationRef
    ).toEqual(predecessorEvaluationRef)
    expect(() =>
      buildTaskContract(
        buildInput({
          turnKind: 'follow_up',
          turnSeq: 2,
          parentSessionId: 'different-parent',
          predecessorEvaluationRef
        })
      )
    ).toThrow(/must belong to the parent Session/u)
  })

  it('rejects duplicate sections, remote references, and bounded-input overflow', () => {
    expect(() =>
      buildTaskContract(
        buildInput({
          acceptance: [
            {
              id: 'sections',
              kind: 'required_sections',
              level: 2,
              sections: ['Handoff', 'handoff']
            }
          ]
        })
      )
    ).toThrow(TaskContractError)
    expect(() =>
      buildTaskContract(
        buildInput({
          acceptance: [
            {
              id: 'schema',
              kind: 'result_schema',
              section: 'Result',
              schema: { $ref: 'https://example.invalid/schema.json' }
            }
          ]
        })
      )
    ).toThrow(/must not contain \$ref/u)
    expect(() =>
      buildTaskContract(
        buildInput({
          acceptance: Array.from(
            { length: MAX_TASK_CONTRACT_REQUIREMENTS + 1 },
            (_, index): DeepChatTaskAcceptanceRequirement => ({
              id: `section-${index}`,
              kind: 'required_sections',
              level: 2,
              sections: [`Section ${index}`]
            })
          )
        })
      )
    ).toThrow(/exceeds 64 requirements/u)
    expect(() =>
      buildTaskContract(
        buildInput({
          acceptance: [
            {
              id: 'oversized-schema',
              kind: 'result_schema',
              section: 'Result',
              schema: { const: 'x'.repeat(32 * 1024) }
            }
          ]
        })
      )
    ).toThrow(/exceeds 32768 UTF-8 bytes/u)

    let deeplyNested: JsonValue = {}
    for (let depth = 0; depth < 66; depth += 1) deeplyNested = { allOf: [deeplyNested] }
    expect(() =>
      buildTaskContract(
        buildInput({
          acceptance: [
            {
              id: 'deep-schema',
              kind: 'result_schema',
              section: 'Result',
              schema: deeplyNested
            }
          ]
        })
      )
    ).toThrow(/structural complexity limit/u)

    let getterRead = false
    const accessorSchema = Object.create(null) as Record<string, JsonValue>
    Object.defineProperty(accessorSchema, 'type', {
      enumerable: true,
      get: () => {
        getterRead = true
        return 'object'
      }
    })
    expect(() =>
      buildTaskContract(
        buildInput({
          acceptance: [
            {
              id: 'accessor-schema',
              kind: 'result_schema',
              section: 'Result',
              schema: accessorSchema
            }
          ]
        })
      )
    ).toThrow(/only data properties/u)
    expect(getterRead).toBe(false)
  })

  it('serializes only complete, normalized physical references', () => {
    expect(
      JSON.parse(
        serializeTaskContractRef({
          schemaVersion: 1,
          sessionId: 'parent-1',
          tapeIdentity: 'a'.repeat(64),
          entryId: 3,
          contractHash: 'b'.repeat(64)
        })
      )
    ).toEqual({
      schemaVersion: 1,
      sessionId: 'parent-1',
      tapeIdentity: 'a'.repeat(64),
      entryId: 3,
      contractHash: 'b'.repeat(64)
    })
    expect(() =>
      serializeTaskContractRef({
        schemaVersion: 1,
        sessionId: ' parent-1',
        tapeIdentity: 'a'.repeat(64),
        entryId: 3,
        contractHash: 'b'.repeat(64)
      })
    ).toThrow(/invalid/u)
    expect(
      restoreTaskContractRef({
        schemaVersion: 1,
        sessionId: ' parent-1',
        tapeIdentity: 'a'.repeat(64),
        entryId: 3,
        contractHash: 'b'.repeat(64)
      })
    ).toBeNull()
    expect(
      restoreTaskContractRef({
        schemaVersion: 1,
        sessionId: 'parent-1',
        tapeIdentity: 'a'.repeat(64),
        entryId: 3,
        contractHash: 'b'.repeat(64),
        unexpected: true
      })
    ).toBeNull()
  })

  it('keeps canonical identity fields within their persisted character bounds', () => {
    expect(() => buildTaskContract(buildInput({ delegationId: 'd'.repeat(257) }))).toThrow(
      TaskContractError
    )
    expect(() => buildTaskContract(buildInput({ title: 't'.repeat(161) }))).toThrow(
      TaskContractError
    )
  })
})
