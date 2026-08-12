import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_CONTEXT_PRESSURE_MIN_OUTPUT_TOKENS,
  buildRequestContextLedger,
  buildRequestContextBudgetDiagnostics,
  buildRequestContextOverflowErrorMessage,
  getUsableContextLength,
  preflightRequestContext
} from '@/agent/deepchat/runtime/contextBudget'
import {
  assemblePromptSections,
  createPromptAssemblySection
} from '@/agent/deepchat/resources/promptAssembly'
import type { ContextRuntimeContributions } from '@/agent/deepchat/runtime/contextContributions'

vi.mock('tokenx', () => ({
  approximateTokenSize: vi.fn((text: string) => text.length)
}))

describe('agent request context budget', () => {
  it('reserves a 256 token safety margin for normal model windows', () => {
    expect(getUsableContextLength(8192)).toBe(7936)
  })

  it('temporarily shrinks maxTokens to fit the safety-adjusted context window', () => {
    const result = preflightRequestContext({
      messages: [{ role: 'user', content: 'x'.repeat(3900) }],
      tools: [],
      contextLength: 8192,
      requestedMaxTokens: 4096
    })

    expect(result.usableContextLength).toBe(7936)
    expect(result.effectiveMaxTokens).toBe(4036)
    expect(result.totalRequestTokens).toBeLessThanOrEqual(7936)
    expect(result.shrunkByContextPressure).toBe(true)
    expect(result.requiresContextPressureRecovery).toBe(false)
  })

  it('requests recovery when pressure would shrink a normal request below 4000 output tokens', () => {
    const result = preflightRequestContext({
      messages: [{ role: 'user', content: 'x'.repeat(4100) }],
      tools: [],
      contextLength: 8192,
      requestedMaxTokens: 4096
    })

    expect(result.effectiveMaxTokens).toBeLessThan(AGENT_CONTEXT_PRESSURE_MIN_OUTPUT_TOKENS)
    expect(result.requiresContextPressureRecovery).toBe(true)
  })

  it('reports zero effective output tokens when the fitted request cannot fit', () => {
    const result = preflightRequestContext({
      messages: [{ role: 'user', content: 'x'.repeat(9000) }],
      tools: [],
      contextLength: 8192,
      requestedMaxTokens: 4096
    })

    expect(result.fitsWithinContext).toBe(false)
    expect(result.effectiveMaxTokens).toBe(0)
    expect(result.totalRequestTokens).toBe(result.inputTokens + result.toolReserveTokens)
  })

  it('respects user configured maxTokens below 4000 without forcing recovery', () => {
    const result = preflightRequestContext({
      messages: [{ role: 'user', content: 'x'.repeat(7200) }],
      tools: [],
      contextLength: 8192,
      requestedMaxTokens: 1024
    })

    expect(result.effectiveMaxTokens).toBe(736)
    expect(result.shrunkByContextPressure).toBe(true)
    expect(result.requiresContextPressureRecovery).toBe(false)
  })

  it('treats non-positive context windows as unknown during preflight', () => {
    const messages = [{ role: 'user' as const, content: 'x'.repeat(2000) }]
    const result = preflightRequestContext({
      messages,
      tools: [],
      contextLength: 0,
      requestedMaxTokens: 4096
    })

    expect(result.messages).toEqual(messages)
    expect(result.effectiveMaxTokens).toBe(4096)
    expect(result.fitsWithinContext).toBe(true)
  })

  it('drops orphaned tool result messages after request fitting', () => {
    const result = preflightRequestContext({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'tool', tool_call_id: 'missing-call', content: 'orphan result' },
        { role: 'user', content: 'continue' }
      ],
      tools: [],
      contextLength: 8192,
      requestedMaxTokens: 4096
    })

    expect(result.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'continue' }
    ])
  })

  it('keeps a replay item with its complete active user turn', () => {
    const result = preflightRequestContext({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'search owner' },
        { role: 'assistant', content: 'visible answer' },
        {
          role: 'assistant',
          provider_replay: { markerId: 'ws_1', payload: 'R'.repeat(200) }
        }
      ],
      tools: [],
      contextLength: 32,
      requestedMaxTokens: 8
    })

    expect(result.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'search owner' },
      { role: 'assistant', content: 'visible answer' },
      {
        role: 'assistant',
        provider_replay: { markerId: 'ws_1', payload: 'R'.repeat(200) }
      }
    ])
    expect(result.fitsWithinContext).toBe(false)
  })

  it('formats diagnostics for unfittable preflight results', () => {
    const result = preflightRequestContext({
      messages: [{ role: 'user', content: 'x'.repeat(9000) }],
      tools: [],
      contextLength: 8192,
      requestedMaxTokens: 4096
    })

    expect(buildRequestContextBudgetDiagnostics(result)).toMatchObject({
      usableContextLength: 7936,
      inputTokens: result.inputTokens,
      toolReserveTokens: 0,
      requestedMaxTokens: 4096,
      effectiveMaxTokens: 0,
      remainingOutputTokens: expect.any(Number),
      totalRequestTokens: result.inputTokens
    })
    expect(buildRequestContextOverflowErrorMessage(result)).toContain('Request was not sent')
    expect(buildRequestContextOverflowErrorMessage(result)).toContain('remaining output room')
    expect(buildRequestContextOverflowErrorMessage(result)).toContain('lowering max output tokens')
  })

  it('derives an ephemeral category ledger from the exact final projection', () => {
    const promptAssembly = assemblePromptSections([
      createPromptAssemblySection({
        kind: 'configured_prompt',
        sourceRef: 'settings:prompt',
        content: 'CONFIGURED'
      }),
      createPromptAssemblySection({
        kind: 'pinned_skills',
        sourceRef: 'skills:active',
        content: 'SESSION_SKILL_BODY'
      })
    ])
    const messageSkillContext = 'MESSAGE_SKILL_BODY'
    const memoryContent = 'MEMORY_CONTENT'
    const preflight = preflightRequestContext({
      messages: [
        { role: 'system', content: promptAssembly.prompt },
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: `old answer quoting ${memoryContent}` },
        {
          role: 'user',
          content: `${memoryContent}\n\n${messageSkillContext}\n\ncurrent question`
        }
      ],
      tools: [],
      contextLength: 0,
      requestedMaxTokens: 100
    })
    const contextContributions = {
      memory: { content: memoryContent },
      memoryIncluded: true,
      directives: { content: null },
      directivesIncluded: false,
      messageSkillActiveTurnContext: messageSkillContext
    } as ContextRuntimeContributions

    const ledger = buildRequestContextLedger({
      preflight,
      promptAssembly,
      contextContributions,
      skills: [
        {
          scope: 'session',
          name: 'persistent-skill',
          effectiveContent: 'SESSION_SKILL_BODY'
        },
        {
          scope: 'message',
          name: 'turn-skill',
          effectiveContent: messageSkillContext
        }
      ]
    })

    expect(ledger.attribution).toBe('available')
    expect(ledger.unattributedInputTokens).toBe(0)
    expect(ledger.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'Configured prompt' }),
        expect.objectContaining({
          category: 'Session Skills',
          contributors: [
            { name: 'persistent-skill', estimatedTokens: 'SESSION_SKILL_BODY'.length }
          ]
        }),
        expect.objectContaining({ category: 'History and tool protocol' }),
        expect.objectContaining({ category: 'Memory', estimatedTokens: memoryContent.length }),
        expect.objectContaining({
          category: 'Message Skills',
          estimatedTokens: messageSkillContext.length,
          contributors: [{ name: 'turn-skill', estimatedTokens: messageSkillContext.length }]
        }),
        expect.objectContaining({ category: 'Current input' }),
        expect.objectContaining({ category: 'Output reserve', estimatedTokens: 100 })
      ])
    )
    const message = buildRequestContextOverflowErrorMessage(preflight, ledger)
    expect(message).toContain('derived at failure time; not persisted')
    expect(message).toContain('persistent-skill ~18')
    expect(message).toContain('Session Skills control above the composer')
  })

  it('reports opaque system attribution instead of reusing stale section costs', () => {
    const promptAssembly = assemblePromptSections([
      createPromptAssemblySection({
        kind: 'configured_prompt',
        sourceRef: 'settings:prompt',
        content: 'STALE_PROMPT'
      })
    ])
    const preflight = preflightRequestContext({
      messages: [
        { role: 'system', content: 'ACTUAL_PROVIDER_PROMPT' },
        { role: 'user', content: 'current question' }
      ],
      tools: [],
      contextLength: 0,
      requestedMaxTokens: 100
    })

    const ledger = buildRequestContextLedger({ preflight, promptAssembly })

    expect(ledger.attribution).toBe('opaque_system_prompt')
    expect(ledger.items).toContainEqual({
      category: 'System prompt (attribution unavailable)',
      estimatedTokens: 'ACTUAL_PROVIDER_PROMPT'.length
    })
    expect(ledger.items.some((item) => item.category === 'Configured prompt')).toBe(false)
  })
})
