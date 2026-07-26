import { createHash } from 'node:crypto'

import type {
  AgentMemoryKind,
  MemoryTombstoneIdentity,
  MemoryTombstoneIdentityKind
} from '../domain/types'
import { normalizeForProvenanceV2 } from './scoring'

const MEMORY_TOMBSTONE_HASH_DOMAIN = 'deepchat.agent-memory.tombstone.v1'

export function isTombstoneEligibleMemoryKind(kind: AgentMemoryKind): boolean {
  return kind !== 'persona' && kind !== 'working'
}

function hashMemoryTombstoneIdentity(
  agentId: string,
  identityKind: MemoryTombstoneIdentityKind,
  value: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([MEMORY_TOMBSTONE_HASH_DOMAIN, identityKind, agentId, value]), 'utf8')
    .digest('hex')
}

export function buildMemoryTombstoneIdentities(input: {
  agentId: string
  content: string
  provenanceKey: string | null
}): MemoryTombstoneIdentity[] {
  const identities: MemoryTombstoneIdentity[] = []
  if (input.provenanceKey) {
    identities.push({
      identityKind: 'provenance',
      identityHash: hashMemoryTombstoneIdentity(input.agentId, 'provenance', input.provenanceKey)
    })
  }
  identities.push({
    identityKind: 'content',
    identityHash: hashMemoryTombstoneIdentity(
      input.agentId,
      'content',
      normalizeForProvenanceV2(input.content)
    )
  })
  return identities
}
