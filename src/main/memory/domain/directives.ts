import { createHash } from 'crypto'
import {
  AGENT_MEMORY_DIRECTIVE_CONTENT_MAX_CHARS,
  AGENT_MEMORY_DIRECTIVE_TOPIC_MAX_CHARS,
  type AgentMemoryDirectiveKind,
  type AgentMemoryDirectiveSource,
  type AgentMemoryDirectiveStatus
} from '@shared/types/agent-memory'
import { unicodeCodePointLength } from '@shared/lib/unicodeText'

export type { AgentMemoryDirectiveKind, AgentMemoryDirectiveSource, AgentMemoryDirectiveStatus }

export interface AgentMemoryDirectiveRow {
  agent_id: string
  id: string
  kind: AgentMemoryDirectiveKind
  status: AgentMemoryDirectiveStatus
  source: AgentMemoryDirectiveSource
  content: string
  normalized_topic: string | null
  identity_hash: string
  created_at: number
  updated_at: number
}

export type MemoryDirectiveInput =
  | {
      kind: 'instruction'
      content: string
      topic?: null
    }
  | {
      kind: 'suppress_topic'
      content: string
      topic: string
    }

export interface NormalizedMemoryDirective {
  kind: AgentMemoryDirectiveKind
  content: string
  normalizedTopic: string | null
  identityHash: string
}

export interface MemoryDirectiveWriteInput extends NormalizedMemoryDirective {
  agentId: string
  id: string
  source: AgentMemoryDirectiveSource
  status: AgentMemoryDirectiveStatus
  createdAt: number
  updatedAt: number
}

export type MemoryDirectiveWriteResult =
  | {
      action: 'created' | 'updated' | 'unchanged'
      row: AgentMemoryDirectiveRow
    }
  | {
      action: 'capacity'
      row: null
    }

export interface MemoryDirectiveInsertResult {
  inserted: boolean
  row: AgentMemoryDirectiveRow
}

export interface MemoryDirectiveCounts {
  draft: number
  active: number
  rejected: number
}

function normalizeWhitespace(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

export function normalizeDirectiveMatchText(value: string): string {
  return normalizeWhitespace(value).toLowerCase()
}

function assertBoundedText(value: string, label: string, maxChars: number): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`[Memory] directive ${label} must not be empty`)
  if (unicodeCodePointLength(trimmed) > maxChars) {
    throw new Error(`[Memory] directive ${label} exceeds ${maxChars} Unicode code points`)
  }
  return trimmed
}

export function normalizeMemoryDirective(input: MemoryDirectiveInput): NormalizedMemoryDirective {
  const content = assertBoundedText(
    input.content,
    'content',
    AGENT_MEMORY_DIRECTIVE_CONTENT_MAX_CHARS
  )
  let normalizedTopic: string | null = null
  if (input.kind === 'instruction') {
    if (input.topic != null) {
      throw new Error('[Memory] instruction directives cannot define a suppression topic')
    }
  } else {
    const topic = assertBoundedText(input.topic, 'topic', AGENT_MEMORY_DIRECTIVE_TOPIC_MAX_CHARS)
    normalizedTopic = normalizeDirectiveMatchText(topic)
    if (!normalizedTopic) throw new Error('[Memory] directive topic must not be empty')
  }

  const identity =
    input.kind === 'suppress_topic' ? normalizedTopic! : normalizeDirectiveMatchText(content)
  const identityHash = createHash('sha256')
    .update('deepchat-memory-directive-v1\0')
    .update(input.kind)
    .update('\0')
    .update(identity)
    .digest('hex')

  return {
    kind: input.kind,
    content,
    normalizedTopic,
    identityHash
  }
}
