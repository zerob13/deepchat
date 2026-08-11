import { describe, expect, it, vi } from 'vitest'
import {
  SkillContextMaterializer,
  type PreparedSkillContextBatch
} from '@/agent/deepchat/runtime/skillContextMaterializer'
import {
  buildTapeSkillMaterializationProvenanceKey,
  buildTapeSkillMaterializationPayloadHash,
  createTapeSkillMaterializationPayload,
  type TapeSkillMaterializationReceipt
} from '@/tape/domain/skillMaterialization'

const HASH = 'a'.repeat(64)

function resolution(name: string, content = `body:${name}`, agentId = 'agent-1') {
  return {
    identity: {
      agentId,
      sourceType: 'builtin' as const,
      sourceId: `source:${name}`,
      skillName: name
    },
    effectiveContent: content,
    builderVersion: 'builder-1',
    renderedManifestHash: HASH,
    scriptInventoryHash: HASH
  }
}

function fixture() {
  let nextEntryId = 20
  const receipts = new Map<number, TapeSkillMaterializationReceipt>()
  const skills = {
    resolveFreshEffectiveSkillContents: vi.fn(async (agentId: string, names: readonly string[]) =>
      names.map((name) => resolution(name, undefined, agentId))
    )
  }
  const tape = {
    getTapeIncarnationId: vi.fn(() => 'incarnation-1'),
    getEffectiveUserMessageSourceEntryId: vi.fn(
      (_sessionId: string, messageId: string) => (messageId === 'user-1' ? 9 : null)
    ),
    materializeSkillContexts: vi.fn(
      (inputs: PreparedSkillContextBatch['items'][number]['materializationInput'][]) =>
        inputs.map((input) => {
          const payload = createTapeSkillMaterializationPayload(input)
          const receipt: TapeSkillMaterializationReceipt = {
            sessionId: input.sessionId,
            entryId: nextEntryId++,
            tapeIncarnationId: input.expectedTapeIncarnationId,
            provenanceKey: buildTapeSkillMaterializationProvenanceKey(input.sessionId, payload),
            payloadHash: buildTapeSkillMaterializationPayloadHash(payload),
            payload
          }
          receipts.set(receipt.entryId, receipt)
          return receipt
        })
    ),
    readSkillMaterialization: vi.fn((ref: { entryId: number }) => receipts.get(ref.entryId)!),
    listViewManifestsByMessage: vi.fn(() => [] as any[]),
    getViewManifestByExecutionBinding: vi.fn(() => null as any)
  }
  return {
    skills,
    tape,
    service: new SkillContextMaterializer({ skills, tape })
  }
}

describe('SkillContextMaterializer', () => {
  it('does zero collaborator work for no-Skill preparation and materialization', async () => {
    const { service, skills, tape } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: [],
      sessionSkillNames: []
    })
    expect(service.materialize(prepared, 'user-1')).toEqual([])
    expect(skills.resolveFreshEffectiveSkillContents).not.toHaveBeenCalled()
    expect(tape.getTapeIncarnationId).not.toHaveBeenCalled()
    expect(tape.getEffectiveUserMessageSourceEntryId).not.toHaveBeenCalled()
    expect(tape.materializeSkillContexts).not.toHaveBeenCalled()
  })

  it('deduplicates overlap in favor of Session scope and resolves once', async () => {
    const { service, skills } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: ['shared', 'message-only'],
      sessionSkillNames: ['shared', 'session-only']
    })
    expect(skills.resolveFreshEffectiveSkillContents).toHaveBeenCalledOnce()
    expect(skills.resolveFreshEffectiveSkillContents).toHaveBeenCalledWith('agent-1', [
      'shared',
      'session-only',
      'message-only'
    ])
    expect(prepared.items.map(({ scope }) => scope)).toEqual(['session', 'session', 'message'])
  })

  it('fails closed on fresh resolver identity/order mismatch', async () => {
    const { service, skills, tape } = fixture()
    skills.resolveFreshEffectiveSkillContents.mockResolvedValueOnce([resolution('wrong')])
    await expect(
      service.prepareFresh({
        sessionId: 'session-1',
        agentId: 'agent-1',
        messageSkillNames: ['expected'],
        sessionSkillNames: []
      })
    ).rejects.toThrow(/identity, order/)
    expect(tape.materializeSkillContexts).not.toHaveBeenCalled()
  })

  it('applies the batch guard before any write', async () => {
    const { service, skills, tape } = fixture()
    await expect(
      service.prepareFresh({
        sessionId: 'session-1',
        agentId: 'agent-1',
        messageSkillNames: Array.from({ length: 65 }, (_, index) => `skill-${index}`),
        sessionSkillNames: []
      })
    ).rejects.toThrow(/exceeds 64 bodies/)
    expect(skills.resolveFreshEffectiveSkillContents).not.toHaveBeenCalled()
    expect(tape.materializeSkillContexts).not.toHaveBeenCalled()
  })

  it('requires the triggering message source fact before writing', async () => {
    const { service, tape } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: ['one'],
      sessionSkillNames: []
    })
    expect(() => service.materialize(prepared, 'missing')).toThrow(/source fact is missing/)
    expect(tape.materializeSkillContexts).not.toHaveBeenCalled()
  })

  it('rejects a cloned prepared batch before source lookup or persistence', async () => {
    const { service, tape } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: ['one'],
      sessionSkillNames: []
    })
    const cloned = { ...prepared }
    expect(() => service.materialize(cloned, 'user-1')).toThrow(/not prepared/)
    expect(tape.getEffectiveUserMessageSourceEntryId).not.toHaveBeenCalled()
    expect(tape.materializeSkillContexts).not.toHaveBeenCalled()
  })

  it('fails closed when strict read-back differs from the prepared payload', async () => {
    const { service, tape } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: [],
      sessionSkillNames: ['one']
    })
    tape.readSkillMaterialization.mockImplementationOnce((ref: { entryId: number }) => {
      const receipt = tape.materializeSkillContexts.mock.results[0]?.value?.[0]
      return { ...receipt, entryId: ref.entryId, tapeIncarnationId: 'wrong' }
    })
    expect(() => service.materialize(prepared, 'user-1')).toThrow(/strict round-trip/)
  })

  it('fails closed when a write receipt carries a drifted payload hash', async () => {
    const { service, tape } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: [],
      sessionSkillNames: ['one']
    })
    const materialize = tape.materializeSkillContexts.getMockImplementation()!
    tape.materializeSkillContexts.mockImplementationOnce((inputs) =>
      materialize(inputs).map((receipt) => ({ ...receipt, payloadHash: 'b'.repeat(64) }))
    )
    expect(() => service.materialize(prepared, 'user-1')).toThrow(/receipt, reference, or payload/)
    expect(tape.readSkillMaterialization).not.toHaveBeenCalled()
  })

  it('recovers only materialized contexts from the highest request in the exact run', async () => {
    const { service, skills, tape } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: [],
      sessionSkillNames: ['one']
    })
    const [projection] = service.materialize(prepared, 'user-1')
    const exact = {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      requestSeq: 4,
      entryId: 40,
      createdAt: 1,
      manifest: {
        schemaVersion: 6,
        runId: 'prior-run',
        requestSeq: 4,
        sessionId: 'session-1',
        messageId: 'assistant-1',
        tapeIncarnationId: 'incarnation-1',
        skillContexts: [
          {
            activationScope: 'runtime_view',
            agentId: 'agent-1',
            sourceType: 'builtin',
            sourceId: 'source:runtime',
            skillName: 'runtime',
            authoritativeRef: {
              kind: 'tool_result',
              entryId: 39,
              contentHash: 'b'.repeat(64)
            },
            providerRole: 'tool',
            sourceEntryIds: [],
            projectedContentHash: 'b'.repeat(64),
            projectionVersion: 1,
            deduplicationSource: 'runtime_view'
          },
          projection.context
        ]
      }
    }
    tape.listViewManifestsByMessage.mockReturnValue([
      {
        ...exact,
        requestSeq: 99,
        manifest: { ...exact.manifest, runId: 'other-run', requestSeq: 99 }
      },
      exact,
      { ...exact, requestSeq: 2, manifest: { ...exact.manifest, requestSeq: 2 } }
    ])
    tape.getViewManifestByExecutionBinding.mockReturnValue(exact)
    const resolveCalls = skills.resolveFreshEffectiveSkillContents.mock.calls.length
    tape.readSkillMaterialization.mockClear()
    expect(
      service.recoverResume({
        sessionId: 'session-1',
        previousRunId: 'prior-run',
        assistantMessageId: 'assistant-1'
      }).projections[0].effectiveContent
    ).toBe('body:one')
    expect(tape.getViewManifestByExecutionBinding).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runId: 'prior-run',
      requestSeq: 4
    })
    expect(tape.readSkillMaterialization).toHaveBeenCalledOnce()
    expect(skills.resolveFreshEffectiveSkillContents).toHaveBeenCalledTimes(resolveCalls)
  })

  it('fails closed instead of silently rewriting recovered projection semantics', async () => {
    const { service, tape } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: [],
      sessionSkillNames: ['one']
    })
    const [projection] = service.materialize(prepared, 'user-1')
    const record = {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      requestSeq: 1,
      entryId: 40,
      createdAt: 1,
      manifest: {
        schemaVersion: 6,
        runId: 'prior-run',
        requestSeq: 1,
        sessionId: 'session-1',
        messageId: 'assistant-1',
        tapeIncarnationId: 'incarnation-1',
        skillContexts: [{ ...projection.context, projectionVersion: 2 }]
      }
    }
    tape.listViewManifestsByMessage.mockReturnValue([record])
    tape.getViewManifestByExecutionBinding.mockReturnValue(record)
    expect(() =>
      service.recoverResume({
        sessionId: 'session-1',
        previousRunId: 'prior-run',
        assistantMessageId: 'assistant-1'
      })
    ).toThrow(/projection semantics/)
  })

  it('rejects recovered materializations with source cardinality outside their scope', async () => {
    const { service, tape } = fixture()
    const prepared = await service.prepareFresh({
      sessionId: 'session-1',
      agentId: 'agent-1',
      messageSkillNames: [],
      sessionSkillNames: ['one']
    })
    const [projection] = service.materialize(prepared, 'user-1')
    const record = {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      requestSeq: 1,
      entryId: 40,
      createdAt: 1,
      manifest: {
        schemaVersion: 6,
        runId: 'prior-run',
        requestSeq: 1,
        sessionId: 'session-1',
        messageId: 'assistant-1',
        tapeIncarnationId: 'incarnation-1',
        skillContexts: [{ ...projection.context, sourceEntryIds: [9] }]
      }
    }
    tape.listViewManifestsByMessage.mockReturnValue([record])
    tape.getViewManifestByExecutionBinding.mockReturnValue(record)
    expect(() =>
      service.recoverResume({
        sessionId: 'session-1',
        previousRunId: 'prior-run',
        assistantMessageId: 'assistant-1'
      })
    ).toThrow(/materialized Skill context/)
  })
})
