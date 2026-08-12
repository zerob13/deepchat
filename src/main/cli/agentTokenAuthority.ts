import { createHash, randomBytes } from 'node:crypto'
import {
  LocalControlMethodSchema,
  LocalControlScopesSchema,
  LocalControlTokenSchema,
  type LocalControlScope
} from '@shared/contracts/localControl'
import {
  MAX_TAPE_PROGRAMMATIC_TOOL_BATCH_STEPS,
  MAX_TAPE_PROGRAMMATIC_TOOL_CHILDREN,
  MAX_TAPE_PROGRAMMATIC_TOOL_DURATION_MS,
  MAX_TAPE_PROGRAMMATIC_TOOL_INPUT_BYTES,
  MAX_TAPE_PROGRAMMATIC_TOOL_OUTPUT_BYTES
} from '@/tape/domain/toolSurfaceFacts'

export const DEFAULT_AGENT_CLI_TOKEN_TTL_MS = 35 * 60_000
export const DEFAULT_AGENT_CLI_TOKEN_MAX_CALLS = 64
export const DEFAULT_AGENT_CLI_TOKEN_MAX_BYTES = 256 * 1024 * 1024
export const MAX_AGENT_CLI_TOKEN_TTL_MS = 60 * 60_000
export const MAX_AGENT_CLI_TOKEN_CALLS = 1024
export const MAX_AGENT_CLI_TOKEN_BYTES = 1024 * 1024 * 1024

const DEFAULT_MAX_TOKENS = 256
const DEFAULT_MAX_TOKENS_PER_CONVERSATION = 8
const SHA_256_PATTERN = /^[0-9a-f]{64}$/
const MAX_OPERATION_IDENTITY_CHARACTERS = 1_024

export const AGENT_CLI_PROGRAMMATIC_GRANT_SCHEMA_VERSION = 1 as const
export const AGENT_CLI_PROGRAMMATIC_SURFACE_VERSION = 2 as const

export type AgentCliProgrammaticToolVerb = 'search' | 'describe' | 'call' | 'batch'

export type AgentCliProgrammaticOperationIdentity = Readonly<{
  sessionId: string
  messageId: string
  runId: string
  requestSeq: number
  providerToolCallId: string
}>

export type AgentCliProgrammaticGrantQuotas = Readonly<{
  maxChildren: number
  maxBatchSteps: number
  maxInputBytes: number
  maxOutputBytes: number
  maxDurationMs: number
}>

export type AgentCliProgrammaticOperationBinding = Readonly<{
  schemaVersion: typeof AGENT_CLI_PROGRAMMATIC_GRANT_SCHEMA_VERSION
  surfaceVersion: typeof AGENT_CLI_PROGRAMMATIC_SURFACE_VERSION
  operation: AgentCliProgrammaticOperationIdentity
  command: Readonly<{
    domain: 'tool'
    verb: AgentCliProgrammaticToolVerb
  }>
  route: string
  canonicalInvocationHash: string
  adapterMode: 'cli-programmatic'
  capabilityHash: string
  programmaticSurfaceHash: string
  quotas: AgentCliProgrammaticGrantQuotas
}>

export type AgentCliOuterDispatchReceipt = Readonly<{
  sessionId: string
  entryId: number
  created: boolean
  preparedTokenId: string
  operation: AgentCliProgrammaticOperationIdentity
}>

export type AgentCliProgrammaticOperationGrant = AgentCliProgrammaticOperationBinding &
  Readonly<{
    outerDispatchReceipt: Readonly<{
      sessionId: string
      entryId: number
    }>
  }>

export type AgentCliTokenClaims = Readonly<{
  tokenId: string
  conversationId: string
  expiresAt: number
  scopes: readonly LocalControlScope[]
  programmaticOperation?: AgentCliProgrammaticOperationGrant
}>

export type IssuedAgentCliToken = AgentCliTokenClaims &
  Readonly<{
    token: string
    maxCalls: number
    maxBytes: number
  }>

export type AgentCliRequestGrant = Readonly<{
  claims: AgentCliTokenClaims
  signal: AbortSignal
  consumeBytes(bytes: number): boolean
  release(): void
}>

export type AgentCliRequestBeginResult =
  | Readonly<{ status: 'granted'; grant: AgentCliRequestGrant }>
  | Readonly<{ status: 'invalid' | 'expired' | 'quota-exhausted' }>

export type ArmedAgentCliProgrammaticToken = IssuedAgentCliToken &
  Readonly<{
    programmaticOperation: AgentCliProgrammaticOperationGrant
  }>

export type PreparedAgentCliProgrammaticGrant = Readonly<{
  tokenId: string
  conversationId: string
  expiresAt: number
  operation: AgentCliProgrammaticOperationIdentity
  binding: AgentCliProgrammaticOperationBinding
  arm(receipt: AgentCliOuterDispatchReceipt): ArmedAgentCliProgrammaticToken
  revoke(): void
}>

export type AgentCliTokenAuthorityOptions = Readonly<{
  now?: () => number
  createToken?: () => string
  createTokenId?: () => string
  maxTokens?: number
  maxTokensPerConversation?: number
}>

type TokenRecord = {
  digest: string
  claims: AgentCliTokenClaims
  state: 'prepared' | 'arming' | 'armed' | 'admitting'
  preparedProgrammaticOperation?: AgentCliProgrammaticOperationBinding
  assertAuthorityActive?: () => void
  maxCalls: number
  maxBytes: number
  usedCalls: number
  usedBytes: number
  activeRequests: number
  issuedAt: number
  controller: AbortController
  expiryTimer: NodeJS.Timeout
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function boundedPositiveSafeInteger(value: number, maximum: number, name: string): number {
  const normalized = positiveSafeInteger(value, name)
  if (normalized > maximum) throw new Error(`${name} exceeds its supported maximum`)
  return normalized
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function normalizeConversationId(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 128) {
    throw new Error('conversationId must contain 1 to 128 characters')
  }
  return normalized
}

function normalizeOperationIdentityValue(value: string, name: string): string {
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_OPERATION_IDENTITY_CHARACTERS ||
    normalized.includes('\0')
  ) {
    throw new Error(`${name} must contain 1 to ${MAX_OPERATION_IDENTITY_CHARACTERS} characters`)
  }
  return normalized
}

function normalizeProgrammaticOperationBinding(
  input: AgentCliProgrammaticOperationBinding
): AgentCliProgrammaticOperationBinding {
  if (input.schemaVersion !== AGENT_CLI_PROGRAMMATIC_GRANT_SCHEMA_VERSION) {
    throw new Error('Programmatic grant schema version is unsupported')
  }
  if (input.surfaceVersion !== AGENT_CLI_PROGRAMMATIC_SURFACE_VERSION) {
    throw new Error('Programmatic local-control surface version is unsupported')
  }
  if (input.command.domain !== 'tool') {
    throw new Error('Programmatic grant command domain must be tool')
  }
  if (!['search', 'describe', 'call', 'batch'].includes(input.command.verb)) {
    throw new Error('Programmatic grant command verb is unsupported')
  }
  if (input.adapterMode !== 'cli-programmatic') {
    throw new Error('Programmatic grant adapter mode is unsupported')
  }
  const operation = Object.freeze({
    sessionId: normalizeConversationId(input.operation.sessionId),
    messageId: normalizeOperationIdentityValue(input.operation.messageId, 'messageId'),
    runId: normalizeOperationIdentityValue(input.operation.runId, 'runId'),
    requestSeq: positiveSafeInteger(input.operation.requestSeq, 'requestSeq'),
    providerToolCallId: normalizeOperationIdentityValue(
      input.operation.providerToolCallId,
      'providerToolCallId'
    )
  })
  const route = LocalControlMethodSchema.parse(input.route)
  if (route !== `tool.${input.command.verb}`) {
    throw new Error('Programmatic grant route does not match its command')
  }
  const canonicalInvocationHash = input.canonicalInvocationHash.trim()
  const capabilityHash = input.capabilityHash.trim()
  const programmaticSurfaceHash = input.programmaticSurfaceHash.trim()
  if (!SHA_256_PATTERN.test(canonicalInvocationHash)) {
    throw new Error('canonicalInvocationHash must be a SHA-256 hash')
  }
  if (!SHA_256_PATTERN.test(capabilityHash)) {
    throw new Error('capabilityHash must be a SHA-256 hash')
  }
  if (!SHA_256_PATTERN.test(programmaticSurfaceHash)) {
    throw new Error('programmaticSurfaceHash must be a SHA-256 hash')
  }
  const maxInputBytes = boundedPositiveSafeInteger(
    input.quotas.maxInputBytes,
    MAX_TAPE_PROGRAMMATIC_TOOL_INPUT_BYTES,
    'maxInputBytes'
  )
  const maxOutputBytes = boundedPositiveSafeInteger(
    input.quotas.maxOutputBytes,
    MAX_TAPE_PROGRAMMATIC_TOOL_OUTPUT_BYTES,
    'maxOutputBytes'
  )
  const quotas = Object.freeze({
    maxChildren: boundedPositiveSafeInteger(
      input.quotas.maxChildren,
      MAX_TAPE_PROGRAMMATIC_TOOL_CHILDREN,
      'maxChildren'
    ),
    maxBatchSteps: boundedPositiveSafeInteger(
      input.quotas.maxBatchSteps,
      MAX_TAPE_PROGRAMMATIC_TOOL_BATCH_STEPS,
      'maxBatchSteps'
    ),
    maxInputBytes,
    maxOutputBytes,
    maxDurationMs: boundedPositiveSafeInteger(
      input.quotas.maxDurationMs,
      MAX_TAPE_PROGRAMMATIC_TOOL_DURATION_MS,
      'maxDurationMs'
    )
  })
  if (quotas.maxBatchSteps > quotas.maxChildren) {
    throw new Error('maxBatchSteps must not exceed maxChildren')
  }
  return Object.freeze({
    schemaVersion: AGENT_CLI_PROGRAMMATIC_GRANT_SCHEMA_VERSION,
    surfaceVersion: AGENT_CLI_PROGRAMMATIC_SURFACE_VERSION,
    operation,
    command: Object.freeze({ domain: 'tool' as const, verb: input.command.verb }),
    route,
    canonicalInvocationHash,
    adapterMode: 'cli-programmatic' as const,
    capabilityHash,
    programmaticSurfaceHash,
    quotas
  })
}

function operationIdentitiesMatch(
  left: AgentCliProgrammaticOperationIdentity,
  right: AgentCliProgrammaticOperationIdentity
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.messageId === right.messageId &&
    left.runId === right.runId &&
    left.requestSeq === right.requestSeq &&
    left.providerToolCallId === right.providerToolCallId
  )
}

export class AgentCliTokenCapacityError extends Error {
  constructor() {
    super('Agent CLI token capacity is exhausted')
    this.name = 'AgentCliTokenCapacityError'
  }
}

export class AgentCliTokenAuthority {
  private readonly now: () => number
  private readonly createToken: () => string
  private readonly createTokenId: () => string
  private readonly maxTokens: number
  private readonly maxTokensPerConversation: number
  private readonly recordsByDigest = new Map<string, TokenRecord>()
  private readonly recordsById = new Map<string, TokenRecord>()
  private readonly digestsByConversation = new Map<string, Set<string>>()

  constructor(options: AgentCliTokenAuthorityOptions = {}) {
    this.now = options.now ?? Date.now
    this.createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'))
    this.createTokenId = options.createTokenId ?? (() => randomBytes(16).toString('base64url'))
    this.maxTokens = positiveSafeInteger(options.maxTokens ?? DEFAULT_MAX_TOKENS, 'maxTokens')
    this.maxTokensPerConversation = positiveSafeInteger(
      options.maxTokensPerConversation ?? DEFAULT_MAX_TOKENS_PER_CONVERSATION,
      'maxTokensPerConversation'
    )
  }

  issue(
    input: Readonly<{
      conversationId: string
      scopes: readonly LocalControlScope[]
      ttlMs?: number
      maxCalls?: number
      maxBytes?: number
    }>
  ): IssuedAgentCliToken {
    const conversationId = normalizeConversationId(input.conversationId)
    const scopes = LocalControlScopesSchema.parse([...input.scopes])
    if (scopes.length === 0) throw new Error('scopes must contain at least one capability')
    const ttlMs = boundedPositiveSafeInteger(
      input.ttlMs ?? DEFAULT_AGENT_CLI_TOKEN_TTL_MS,
      MAX_AGENT_CLI_TOKEN_TTL_MS,
      'ttlMs'
    )
    const maxCalls = boundedPositiveSafeInteger(
      input.maxCalls ?? DEFAULT_AGENT_CLI_TOKEN_MAX_CALLS,
      MAX_AGENT_CLI_TOKEN_CALLS,
      'maxCalls'
    )
    const maxBytes = boundedPositiveSafeInteger(
      input.maxBytes ?? DEFAULT_AGENT_CLI_TOKEN_MAX_BYTES,
      MAX_AGENT_CLI_TOKEN_BYTES,
      'maxBytes'
    )
    const allocation = this.allocateToken(conversationId, ttlMs)
    const claims: AgentCliTokenClaims = {
      tokenId: allocation.tokenId,
      conversationId,
      expiresAt: allocation.expiresAt,
      scopes: Object.freeze(scopes)
    }
    const record: TokenRecord = {
      digest: allocation.digest,
      claims,
      state: 'armed',
      maxCalls,
      maxBytes,
      usedCalls: 0,
      usedBytes: 0,
      activeRequests: 0,
      issuedAt: allocation.issuedAt,
      controller: allocation.controller,
      expiryTimer: allocation.expiryTimer
    }
    this.registerRecord(record)

    return { token: allocation.token, ...claims, maxCalls, maxBytes }
  }

  prepareProgrammaticOperation(
    input: Readonly<{
      binding: AgentCliProgrammaticOperationBinding
      ttlMs?: number
      assertAuthorityActive: () => void
    }>
  ): PreparedAgentCliProgrammaticGrant {
    const binding = normalizeProgrammaticOperationBinding(input.binding)
    const conversationId = normalizeConversationId(binding.operation.sessionId)
    if (typeof input.assertAuthorityActive !== 'function') {
      throw new Error('Programmatic grant requires a process-live authority assertion')
    }
    input.assertAuthorityActive()
    const ttlMs = boundedPositiveSafeInteger(
      input.ttlMs ?? Math.min(binding.quotas.maxDurationMs, DEFAULT_AGENT_CLI_TOKEN_TTL_MS),
      Math.min(binding.quotas.maxDurationMs, MAX_AGENT_CLI_TOKEN_TTL_MS),
      'ttlMs'
    )
    const maxBytes = binding.quotas.maxInputBytes + binding.quotas.maxOutputBytes
    const allocation = this.allocateToken(conversationId, ttlMs)
    const claims: AgentCliTokenClaims = Object.freeze({
      tokenId: allocation.tokenId,
      conversationId,
      expiresAt: allocation.expiresAt,
      scopes: Object.freeze([])
    })
    const record: TokenRecord = {
      digest: allocation.digest,
      claims,
      state: 'prepared',
      preparedProgrammaticOperation: binding,
      assertAuthorityActive: input.assertAuthorityActive,
      maxCalls: 1,
      maxBytes,
      usedCalls: 0,
      usedBytes: 0,
      activeRequests: 0,
      issuedAt: allocation.issuedAt,
      controller: allocation.controller,
      expiryTimer: allocation.expiryTimer
    }
    this.registerRecord(record)
    let armAttempted = false
    let revoked = false
    return Object.freeze({
      tokenId: claims.tokenId,
      conversationId,
      expiresAt: claims.expiresAt,
      operation: binding.operation,
      binding,
      arm: (receipt) => {
        if (armAttempted || revoked) throw new Error('Programmatic grant is no longer pending')
        armAttempted = true
        return this.armProgrammaticOperation(record, allocation.token, receipt)
      },
      revoke: () => {
        if (revoked) return
        revoked = true
        this.removeRecord(record.digest, 'revoked')
      }
    })
  }

  beginRequest(token: string): AgentCliRequestBeginResult {
    const parsedToken = LocalControlTokenSchema.safeParse(token)
    if (!parsedToken.success) return { status: 'invalid' }
    const digest = tokenDigest(parsedToken.data)
    const record = this.recordsByDigest.get(digest)
    if (!record) return { status: 'invalid' }
    if (record.state !== 'armed') return { status: 'invalid' }
    if (record.claims.expiresAt <= this.now()) {
      this.removeRecord(digest, 'expired')
      return { status: 'expired' }
    }
    const validatesProgrammaticAuthority = Boolean(record.assertAuthorityActive)
    if (validatesProgrammaticAuthority) record.state = 'admitting'
    try {
      record.assertAuthorityActive?.()
    } catch {
      this.removeRecord(digest, 'revoked')
      return { status: 'invalid' }
    }
    if (
      this.recordsByDigest.get(digest) !== record ||
      record.state !== (validatesProgrammaticAuthority ? 'admitting' : 'armed') ||
      record.controller.signal.aborted
    ) {
      return { status: 'invalid' }
    }
    if (record.claims.expiresAt <= this.now()) {
      this.removeRecord(digest, 'expired')
      return { status: 'expired' }
    }
    record.state = 'armed'
    if (record.usedCalls >= record.maxCalls || record.usedBytes >= record.maxBytes) {
      return { status: 'quota-exhausted' }
    }

    record.usedCalls += 1
    record.activeRequests += 1
    let released = false
    return {
      status: 'granted',
      grant: {
        claims: record.claims,
        signal: record.controller.signal,
        consumeBytes: (bytes) => this.consumeRecordBytes(record, bytes),
        release: () => {
          if (released) return
          released = true
          record.activeRequests = Math.max(0, record.activeRequests - 1)
        }
      }
    }
  }

  consumeBytes(tokenId: string, bytes: number): boolean {
    const record = this.recordsById.get(tokenId)
    return record?.state === 'armed' && record.activeRequests > 0
      ? this.consumeRecordBytes(record, bytes)
      : false
  }

  revokeConversation(conversationId: string): void {
    const normalized = conversationId.trim()
    if (!normalized) return
    for (const digest of this.digestsByConversation.get(normalized) ?? []) {
      this.removeRecord(digest, 'revoked')
    }
  }

  clear(): void {
    for (const digest of this.recordsByDigest.keys()) {
      this.removeRecord(digest, 'revoked')
    }
  }

  snapshot(): Readonly<{ tokens: number; conversations: number }> {
    this.pruneRetired(this.now())
    return {
      tokens: this.recordsByDigest.size,
      conversations: this.digestsByConversation.size
    }
  }

  private allocateToken(
    conversationId: string,
    ttlMs: number
  ): Readonly<{
    token: string
    tokenId: string
    digest: string
    issuedAt: number
    expiresAt: number
    controller: AbortController
    expiryTimer: NodeJS.Timeout
  }> {
    const issuedAt = this.now()
    if (issuedAt > Number.MAX_SAFE_INTEGER - ttlMs) {
      throw new Error('Agent CLI token expiry is outside the supported range')
    }
    this.pruneRetired(issuedAt)
    const replacesConversationToken =
      (this.digestsByConversation.get(conversationId)?.size ?? 0) >= this.maxTokensPerConversation
    if (this.recordsByDigest.size >= this.maxTokens && !replacesConversationToken) {
      throw new AgentCliTokenCapacityError()
    }
    const token = LocalControlTokenSchema.parse(this.createUniqueToken())
    const tokenId = this.createUniqueTokenId()
    if (replacesConversationToken) this.enforceConversationCapacity(conversationId)
    if (this.recordsByDigest.size >= this.maxTokens) {
      throw new AgentCliTokenCapacityError()
    }
    const digest = tokenDigest(token)
    const controller = new AbortController()
    const expiryTimer = setTimeout(() => this.removeRecord(digest, 'expired'), ttlMs)
    expiryTimer.unref()
    return {
      token,
      tokenId,
      digest,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      controller,
      expiryTimer
    }
  }

  private registerRecord(record: TokenRecord): void {
    this.recordsByDigest.set(record.digest, record)
    this.recordsById.set(record.claims.tokenId, record)
    const conversationTokens =
      this.digestsByConversation.get(record.claims.conversationId) ?? new Set<string>()
    conversationTokens.add(record.digest)
    this.digestsByConversation.set(record.claims.conversationId, conversationTokens)
  }

  private armProgrammaticOperation(
    record: TokenRecord,
    token: string,
    receipt: AgentCliOuterDispatchReceipt
  ): ArmedAgentCliProgrammaticToken {
    try {
      if (this.recordsByDigest.get(record.digest) !== record || record.state !== 'prepared') {
        throw new Error('Programmatic grant is no longer pending')
      }
      if (!record.preparedProgrammaticOperation || !record.assertAuthorityActive) {
        throw new Error('Programmatic grant lost its prepared authority')
      }
      if (record.claims.expiresAt <= this.now()) {
        throw new Error('Programmatic grant expired before outer dispatch committed')
      }
      record.state = 'arming'
      record.assertAuthorityActive()
      if (
        this.recordsByDigest.get(record.digest) !== record ||
        record.state !== 'arming' ||
        record.controller.signal.aborted
      ) {
        throw new Error('Programmatic grant is no longer pending')
      }
      if (record.claims.expiresAt <= this.now()) {
        throw new Error('Programmatic grant expired before outer dispatch committed')
      }
      if (
        receipt.created !== true ||
        receipt.sessionId !== record.claims.conversationId ||
        receipt.preparedTokenId !== record.claims.tokenId ||
        !Number.isSafeInteger(receipt.entryId) ||
        receipt.entryId <= 0 ||
        !operationIdentitiesMatch(receipt.operation, record.preparedProgrammaticOperation.operation)
      ) {
        throw new Error('Programmatic grant requires its newly committed outer dispatch receipt')
      }
      const programmaticOperation: AgentCliProgrammaticOperationGrant = Object.freeze({
        ...record.preparedProgrammaticOperation,
        outerDispatchReceipt: Object.freeze({
          sessionId: receipt.sessionId,
          entryId: receipt.entryId
        })
      })
      record.claims = Object.freeze({
        ...record.claims,
        programmaticOperation
      })
      record.preparedProgrammaticOperation = undefined
      record.state = 'armed'
      return {
        token,
        ...record.claims,
        programmaticOperation,
        maxCalls: record.maxCalls,
        maxBytes: record.maxBytes
      }
    } catch (error) {
      this.removeRecord(record.digest, 'revoked')
      throw error
    }
  }

  private createUniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.createToken()
      if (!this.recordsByDigest.has(tokenDigest(candidate))) return candidate
    }
    throw new Error('Failed to allocate a unique Agent CLI token')
  }

  private createUniqueTokenId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.createTokenId()
      if (/^[A-Za-z0-9_-]{16,128}$/.test(candidate) && !this.recordsById.has(candidate)) {
        return candidate
      }
    }
    throw new Error('Failed to allocate a unique Agent CLI token ID')
  }

  private consumeRecordBytes(record: TokenRecord, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('Agent CLI byte usage must be a non-negative safe integer')
    }
    if (this.recordsByDigest.get(record.digest) !== record) return false
    if (record.claims.expiresAt <= this.now()) {
      this.removeRecord(record.digest, 'expired')
      return false
    }
    if (bytes > record.maxBytes - record.usedBytes) {
      record.usedBytes = record.maxBytes
      return false
    }
    record.usedBytes += bytes
    return true
  }

  private enforceConversationCapacity(conversationId: string): void {
    const conversationTokens = this.digestsByConversation.get(conversationId)
    if (!conversationTokens || conversationTokens.size < this.maxTokensPerConversation) return
    const oldest = [...conversationTokens]
      .map((digest) => this.recordsByDigest.get(digest))
      .filter((record): record is TokenRecord => Boolean(record))
      .sort(
        (left, right) =>
          left.issuedAt - right.issuedAt || left.claims.tokenId.localeCompare(right.claims.tokenId)
      )[0]
    if (oldest) this.removeRecord(oldest.digest, 'replaced')
  }

  private pruneRetired(now: number): void {
    for (const record of this.recordsByDigest.values()) {
      if (record.claims.expiresAt <= now) {
        this.removeRecord(record.digest, 'expired')
        continue
      }
      if (
        record.activeRequests === 0 &&
        (record.usedCalls >= record.maxCalls || record.usedBytes >= record.maxBytes)
      ) {
        this.removeRecord(record.digest, 'exhausted')
      }
    }
  }

  private removeRecord(
    digest: string,
    reason: 'expired' | 'exhausted' | 'replaced' | 'revoked'
  ): void {
    const record = this.recordsByDigest.get(digest)
    if (!record) return
    this.recordsByDigest.delete(digest)
    this.recordsById.delete(record.claims.tokenId)
    const conversationTokens = this.digestsByConversation.get(record.claims.conversationId)
    conversationTokens?.delete(digest)
    if (conversationTokens?.size === 0) {
      this.digestsByConversation.delete(record.claims.conversationId)
    }
    clearTimeout(record.expiryTimer)
    record.controller.abort(new Error(`Agent CLI token ${reason}`))
  }
}
