import { describe, expect, it, vi } from 'vitest'
import { AGENT_MEMORY_DIRECTIVE_CONTENT_MAX_CHARS } from '@shared/types/agent-memory'

import { makePresenter } from './support/memoryFakes'

describe('DirectiveService', () => {
  it('requires explicit approval before a derived suggestion becomes active', () => {
    let now = 1_000
    const onMemoryChanged = vi.fn()
    const { presenter, auditRepo } = makePresenter(
      { memoryEnabled: true },
      undefined,
      { clock: { now: () => now, timeZone: () => 'UTC' }, onMemoryChanged }
    )

    const draft = presenter.suggestDirective('a', {
      kind: 'suppress_topic',
      content: 'Do not mention Project Saffron.',
      topic: 'Project Saffron'
    })
    expect(draft).toMatchObject({
      status: 'draft',
      source: 'derived_suggestion',
      normalized_topic: 'project saffron'
    })
    expect(presenter.listActiveDirectives('a')).toEqual([])
    expect(presenter.getStatus('a')).toMatchObject({
      directiveDraftCount: 1,
      activeDirectiveCount: 0
    })

    now = 2_000
    expect(presenter.approveDirective('a', draft!.id)).toMatchObject({
      id: draft!.id,
      status: 'active',
      source: 'derived_suggestion'
    })
    expect(presenter.listActiveDirectives('a')).toHaveLength(1)
    expect(presenter.getStatus('a')).toMatchObject({
      directiveDraftCount: 0,
      activeDirectiveCount: 1
    })
    expect(presenter.approveDirective('a', draft!.id)).toBeNull()
    expect(presenter.listDirectives('a')).toHaveLength(1)

    const serializedAudit = JSON.stringify(auditRepo.rows)
    expect(serializedAudit).not.toContain('Project Saffron')
    expect(auditRepo.rows.map((row) => row.event_type)).toEqual([
      'memory/directive_suggest',
      'memory/directive_approve'
    ])
    expect(onMemoryChanged.mock.calls).toEqual([
      ['a', 'directive-suggest', { directiveId: draft!.id }],
      ['a', 'directive-approve', { directiveId: draft!.id }]
    ])
  })

  it('does not let repeated model output reopen a rejected suggestion', () => {
    const { presenter } = makePresenter({ memoryEnabled: true })
    const input = {
      kind: 'instruction' as const,
      content: 'Prefer concise answers.'
    }
    const draft = presenter.suggestDirective('a', input)
    expect(draft).not.toBeNull()
    expect(presenter.rejectDirective('a', draft!.id)).toMatchObject({ status: 'rejected' })

    expect(presenter.suggestDirective('a', input)).toBeNull()
    expect(presenter.listDirectives('a')).toEqual([
      expect.objectContaining({ id: draft!.id, status: 'rejected' })
    ])

    const explicit = presenter.createDirective('a', input, 'explicit_user')
    expect(explicit).toMatchObject({
      id: draft!.id,
      status: 'active',
      source: 'explicit_user'
    })
  })

  it('deduplicates normalized explicit content and emits no duplicate mutation', () => {
    const { presenter, auditRepo } = makePresenter({ memoryEnabled: true })
    const first = presenter.createDirective('a', {
      kind: 'instruction',
      content: 'Use concise answers.'
    })
    const duplicate = presenter.createDirective('a', {
      kind: 'instruction',
      content: 'Use concise answers.'
    })

    expect(duplicate?.id).toBe(first?.id)
    expect(presenter.listDirectives('a')).toHaveLength(1)
    expect(
      auditRepo.rows.filter((row) => row.event_type === 'memory/directive_create')
    ).toHaveLength(1)
  })

  it('enforces ownership, disabled-runtime isolation, deletion, and input bounds', () => {
    const { presenter } = makePresenter({ memoryEnabled: true })
    const active = presenter.createDirective('a', {
      kind: 'suppress_topic',
      content: 'Do not mention Alpha.',
      topic: 'Alpha'
    })
    expect(active).not.toBeNull()
    expect(presenter.listDirectives('b')).toEqual([])
    expect(presenter.approveDirective('b', active!.id)).toBeNull()
    expect(presenter.deleteDirective('b', active!.id)).toBe(false)
    expect(presenter.deleteDirective('a', active!.id)).toBe(true)
    expect(presenter.listDirectives('a')).toEqual([])

    expect(() =>
      presenter.createDirective('bad/id', {
        kind: 'instruction',
        content: 'Unsafe owner'
      })
    ).toThrow(/invalid agentId/)
    expect(() =>
      presenter.createDirective('a', {
        kind: 'instruction',
        content: 'x'.repeat(AGENT_MEMORY_DIRECTIVE_CONTENT_MAX_CHARS + 1)
      })
    ).toThrow(/exceeds/)

    const disabled = makePresenter({ memoryEnabled: false }).presenter
    const disabledDirective = disabled.createDirective('a', {
      kind: 'instruction',
      content: 'Inactive until memory is enabled.'
    })
    expect(disabledDirective).toMatchObject({ status: 'active' })
    expect(disabled.listActiveDirectives('a')).toEqual([])
    expect(disabled.deleteDirective('a', disabledDirective!.id)).toBe(true)
  })
})
