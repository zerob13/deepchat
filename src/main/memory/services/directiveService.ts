import { nanoid } from 'nanoid'
import { AGENT_MEMORY_ACTIVE_DIRECTIVE_MAX_COUNT } from '@shared/types/agent-memory'

import {
  normalizeMemoryDirective,
  type AgentMemoryDirectiveRow,
  type MemoryDirectiveInput
} from '../domain/directives'
import type { MemoryRuntimeContext } from '../context'
import type { MemoryDirectiveRepositoryPort } from '../ports'

const DIRECTIVE_ID_PREFIX = 'directive-'
export const ACTIVE_DIRECTIVE_READ_LIMIT = AGENT_MEMORY_ACTIVE_DIRECTIVE_MAX_COUNT
export const DIRECTIVE_MANAGEMENT_READ_LIMIT = 200

export class DirectiveService {
  constructor(
    private readonly ports: {
      ctx: MemoryRuntimeContext
      repository: MemoryDirectiveRepositoryPort
    }
  ) {}

  listDirectives(
    agentId: string,
    options: {
      statuses?: readonly AgentMemoryDirectiveRow['status'][]
      limit?: number
    } = {}
  ): AgentMemoryDirectiveRow[] {
    this.ports.ctx.assertSafeAgentId(agentId)
    if (!this.ports.ctx.isManagedAgent(agentId)) return []
    return this.ports.repository.listDirectives(agentId, {
      statuses: options.statuses,
      limit: Math.min(
        DIRECTIVE_MANAGEMENT_READ_LIMIT,
        Math.max(0, Math.floor(options.limit ?? DIRECTIVE_MANAGEMENT_READ_LIMIT))
      )
    })
  }

  listActiveDirectives(agentId: string): AgentMemoryDirectiveRow[] {
    this.ports.ctx.assertSafeAgentId(agentId)
    if (!this.ports.ctx.canReadAgentMemory(agentId)) return []
    return this.ports.repository.listActiveDirectives(agentId, ACTIVE_DIRECTIVE_READ_LIMIT)
  }

  createExplicitDirective(
    agentId: string,
    input: MemoryDirectiveInput,
    source: 'explicit_user' | 'manual' = 'manual'
  ): AgentMemoryDirectiveRow | null {
    this.ports.ctx.assertSafeAgentId(agentId)
    if (!this.ports.ctx.canManageAgentMemory(agentId)) return null
    const normalized = normalizeMemoryDirective(input)
    const now = this.ports.ctx.now()
    const result = this.ports.repository.upsertExplicitDirective({
      agentId,
      id: `${DIRECTIVE_ID_PREFIX}${nanoid(12)}`,
      ...normalized,
      source,
      status: 'active',
      createdAt: now,
      updatedAt: now
    })
    if (result.action === 'capacity') return null
    if (result.action === 'unchanged') return result.row

    this.ports.ctx.markDomainMutationCommitted(agentId)
    this.ports.ctx.writeAudit(agentId, {
      eventType: 'memory/directive_create',
      actorType: 'user',
      status: 'completed',
      outputRefs: {
        directiveId: result.row.id,
        kind: result.row.kind,
        status: result.row.status,
        source: result.row.source
      },
      createdAt: now
    })
    this.ports.ctx.emitChanged(agentId, 'directive-create', { directiveId: result.row.id })
    return result.row
  }

  suggestDirective(agentId: string, input: MemoryDirectiveInput): AgentMemoryDirectiveRow | null {
    this.ports.ctx.assertSafeAgentId(agentId)
    if (!this.ports.ctx.canWriteAgentMemory(agentId)) return null
    const normalized = normalizeMemoryDirective(input)
    const now = this.ports.ctx.now()
    const result = this.ports.repository.insertDerivedDirectiveDraft({
      agentId,
      id: `${DIRECTIVE_ID_PREFIX}${nanoid(12)}`,
      ...normalized,
      source: 'derived_suggestion',
      status: 'draft',
      createdAt: now,
      updatedAt: now
    })
    if (!result.inserted) return null

    this.ports.ctx.markDomainMutationCommitted(agentId)
    this.ports.ctx.writeAudit(agentId, {
      eventType: 'memory/directive_suggest',
      actorType: 'runtime',
      status: 'completed',
      outputRefs: {
        directiveId: result.row.id,
        kind: result.row.kind,
        status: result.row.status,
        source: result.row.source
      },
      createdAt: now
    })
    this.ports.ctx.emitChanged(agentId, 'directive-suggest', { directiveId: result.row.id })
    return result.row
  }

  approveDirective(agentId: string, directiveId: string): AgentMemoryDirectiveRow | null {
    return this.transitionDraft(agentId, directiveId, 'active')
  }

  rejectDirective(agentId: string, directiveId: string): AgentMemoryDirectiveRow | null {
    return this.transitionDraft(agentId, directiveId, 'rejected')
  }

  private transitionDraft(
    agentId: string,
    directiveId: string,
    status: 'active' | 'rejected'
  ): AgentMemoryDirectiveRow | null {
    this.ports.ctx.assertSafeAgentId(agentId)
    if (!this.ports.ctx.canManageAgentMemory(agentId)) return null
    const id = directiveId.trim()
    if (!id) return null
    const now = this.ports.ctx.now()
    const row = this.ports.repository.transitionDirective(agentId, id, 'draft', status, now)
    if (!row) return null

    this.ports.ctx.markDomainMutationCommitted(agentId)
    this.ports.ctx.writeAudit(agentId, {
      eventType: status === 'active' ? 'memory/directive_approve' : 'memory/directive_reject',
      actorType: 'user',
      status: 'completed',
      inputRefs: { directiveId: id },
      outputRefs: { directiveId: id, kind: row.kind, status },
      createdAt: now
    })
    this.ports.ctx.emitChanged(
      agentId,
      status === 'active' ? 'directive-approve' : 'directive-reject',
      { directiveId: id }
    )
    return row
  }

  deleteDirective(agentId: string, directiveId: string): boolean {
    this.ports.ctx.assertSafeAgentId(agentId)
    if (!this.ports.ctx.canManageAgentMemory(agentId)) return false
    const id = directiveId.trim()
    if (!id) return false
    const row = this.ports.repository.deleteDirective(agentId, id)
    if (!row) return false
    const now = this.ports.ctx.now()

    this.ports.ctx.markDomainMutationCommitted(agentId)
    this.ports.ctx.writeAudit(agentId, {
      eventType: 'memory/directive_delete',
      actorType: 'user',
      status: 'completed',
      inputRefs: { directiveId: id },
      outputRefs: { directiveId: id, kind: row.kind, status: row.status },
      createdAt: now
    })
    this.ports.ctx.emitChanged(agentId, 'directive-delete', { directiveId: id })
    return true
  }

  getCounts(agentId: string) {
    this.ports.ctx.assertSafeAgentId(agentId)
    if (!this.ports.ctx.isManagedAgent(agentId)) {
      return { draft: 0, active: 0, rejected: 0 }
    }
    return this.ports.repository.countDirectivesByStatus(agentId)
  }
}
