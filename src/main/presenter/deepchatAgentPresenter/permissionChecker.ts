import path from 'path'
import { eventBus, SendTarget } from '@/eventbus'
import { STREAM_EVENTS } from '@/events'
import type { SessionRecord } from '@shared/types/agent-interface'

export type PermissionStatus = 'pending' | 'granted' | 'denied'

export interface PermissionRequest {
  id: string
  sessionId: string
  messageId: string
  toolName: string
  toolCallId: string
  action?: string
  paths?: string[]
  command?: string
  commandSignature?: string
  status: PermissionStatus
  rememberable: boolean
}

export interface PermissionBatch {
  messageId: string
  sessionId: string
  requests: PermissionRequest[]
  status: 'pending' | 'completed'
}

/**
 * PermissionChecker - Handles permission validation for tool execution
 *
 * Features:
 * 1. Full access mode: auto-approves within projectDir boundary
 * 2. Default mode: requires explicit approval, supports whitelist
 * 3. Batch permission handling for multiple tool calls in one message
 * 4. Pause/resume mechanism with idempotent resume
 */
export class PermissionChecker {
  private session: SessionRecord
  private pendingBatches: Map<string, PermissionBatch> = new Map()
  private permissionResolvers: Map<string, (approved: boolean) => void> = new Map()
  private resumeLocks: Set<string> = new Set() // Message-level resume lock
  private whitelist: Map<string, Set<string>> = new Map() // toolName -> signatures/patterns

  constructor(session: SessionRecord) {
    this.session = session
  }

  /**
   * Check if a tool call needs permission
   * Returns true if permission is required, false if auto-approved
   */
  async needsPermission(
    toolName: string,
    params: {
      path?: string
      paths?: string[]
      command?: string
      commandSignature?: string
    } = {}
  ): Promise<boolean> {
    // Full access mode: only check projectDir boundary
    if (this.session.permissionMode === 'full') {
      // Check if all paths are within projectDir
      const allPaths = params.path ? [params.path] : params.paths || []
      for (const p of allPaths) {
        if (!this.isWithinProjectDir(p)) {
          throw new Error(`Operation outside project directory: ${p}`)
        }
      }
      return false // Auto-approve within boundary
    }

    // Default mode: check whitelist
    const signature = this.buildSignature(toolName, params)
    if (this.isWhitelisted(toolName, signature)) {
      return false
    }

    return true
  }

  /**
   * Create a permission batch for a message's tool calls
   */
  createBatch(
    sessionId: string,
    messageId: string,
    toolCalls: Array<{
      id: string
      name: string
      arguments: string
    }>
  ): PermissionBatch {
    const requests: PermissionRequest[] = toolCalls.map((tc) => {
      const args = this.safeParseArgs(tc.arguments) as Record<string, string | string[]> | null
      return {
        id: `${messageId}_${tc.id}`,
        sessionId,
        messageId,
        toolName: tc.name,
        toolCallId: tc.id,
        action: args?.action as string | undefined,
        paths: args?.path ? [args.path as string] : (args?.paths as string[] | undefined),
        command: args?.command as string | undefined,
        commandSignature: args?.command
          ? this.extractCommandSignature(args.command as string)
          : undefined,
        status: 'pending',
        rememberable: true
      }
    })

    const batch: PermissionBatch = {
      messageId,
      sessionId,
      requests,
      status: 'pending'
    }

    this.pendingBatches.set(messageId, batch)
    return batch
  }

  /**
   * Emit permission requests for a batch and wait for all to be resolved
   */
  async requestPermissions(batch: PermissionBatch): Promise<Map<string, boolean>> {
    // Emit permission request events for each pending permission
    for (const request of batch.requests) {
      eventBus.sendToRenderer(STREAM_EVENTS.PERMISSION_UPDATED, SendTarget.ALL_WINDOWS, {
        type: 'request',
        sessionId: batch.sessionId,
        messageId: batch.messageId,
        request
      })
    }

    // Create promises for each permission
    const promises = batch.requests.map(
      (request) =>
        new Promise<boolean>((resolve) => {
          this.permissionResolvers.set(request.id, resolve)
        })
    )

    // Wait for all permissions to be resolved
    const results = await Promise.all(promises)

    // Build result map
    const resultMap = new Map<string, boolean>()
    batch.requests.forEach((request, index) => {
      resultMap.set(request.toolCallId, results[index])
    })

    batch.status = 'completed'
    return resultMap
  }

  /**
   * Handle a permission response from the user
   */
  handlePermissionResponse(requestId: string, approved: boolean, remember: boolean): void {
    const batch = this.findBatchByRequestId(requestId)
    if (!batch) {
      console.warn(`[PermissionChecker] No batch found for request: ${requestId}`)
      return
    }

    const request = batch.requests.find((r) => r.id === requestId)
    if (!request) {
      console.warn(`[PermissionChecker] No request found: ${requestId}`)
      return
    }

    // Update request status
    request.status = approved ? 'granted' : 'denied'

    // Add to whitelist if approved and remember
    if (approved && remember && request.rememberable) {
      this.addToWhitelist(request.toolName, request)
    }

    // Notify renderer of update
    eventBus.sendToRenderer(STREAM_EVENTS.PERMISSION_UPDATED, SendTarget.ALL_WINDOWS, {
      type: 'response',
      sessionId: batch.sessionId,
      messageId: batch.messageId,
      requestId,
      approved,
      request
    })

    // Resolve the promise
    const resolver = this.permissionResolvers.get(requestId)
    if (resolver) {
      resolver(approved)
      this.permissionResolvers.delete(requestId)
    }
  }

  /**
   * Check if a batch has all permissions resolved
   */
  isBatchResolved(messageId: string): boolean {
    const batch = this.pendingBatches.get(messageId)
    if (!batch) return true
    return batch.requests.every((r) => r.status !== 'pending')
  }

  /**
   * Get the permission result for a specific tool call
   */
  getPermissionResult(messageId: string, toolCallId: string): boolean | null {
    const batch = this.pendingBatches.get(messageId)
    if (!batch) return null
    const request = batch.requests.find((r) => r.toolCallId === toolCallId)
    if (!request || request.status === 'pending') return null
    return request.status === 'granted'
  }

  /**
   * Acquire resume lock for a message (idempotency)
   * Returns true if lock acquired, false if already locked
   */
  acquireResumeLock(messageId: string): boolean {
    if (this.resumeLocks.has(messageId)) {
      return false
    }
    this.resumeLocks.add(messageId)
    return true
  }

  /**
   * Release resume lock for a message
   */
  releaseResumeLock(messageId: string): void {
    this.resumeLocks.delete(messageId)
  }

  /**
   * Check if a message has resume lock
   */
  hasResumeLock(messageId: string): boolean {
    return this.resumeLocks.has(messageId)
  }

  /**
   * Clean up batch and locks for a message
   */
  cleanup(messageId: string): void {
    this.pendingBatches.delete(messageId)
    this.resumeLocks.delete(messageId)
  }

  /**
   * Add to whitelist
   */
  private addToWhitelist(toolName: string, request: PermissionRequest): void {
    const key = this.buildWhitelistKey(request)
    if (!this.whitelist.has(toolName)) {
      this.whitelist.set(toolName, new Set())
    }
    this.whitelist.get(toolName)!.add(key)
  }

  /**
   * Check if a tool/signature is whitelisted
   */
  private isWhitelisted(toolName: string, signature: string): boolean {
    const toolWhitelist = this.whitelist.get(toolName)
    if (!toolWhitelist) return false
    return toolWhitelist.has(signature)
  }

  /**
   * Build a signature for whitelist checking
   */
  private buildWhitelistKey(request: PermissionRequest): string {
    if (request.commandSignature) {
      return `cmd:${request.commandSignature}`
    }
    if (request.paths && request.paths.length > 0) {
      return `path:${request.paths.join(',')}`
    }
    return `tool:${request.toolName}`
  }

  /**
   * Build a signature from tool params
   */
  private buildSignature(
    toolName: string,
    params: { path?: string; paths?: string[]; command?: string; commandSignature?: string }
  ): string {
    if (params.commandSignature) {
      return `cmd:${params.commandSignature}`
    }
    if (params.command) {
      return `cmd:${this.extractCommandSignature(params.command)}`
    }
    const paths = params.path ? [params.path] : params.paths || []
    if (paths.length > 0) {
      return `path:${paths.join(',')}`
    }
    return `tool:${toolName}`
  }

  /**
   * Check if path is within project directory
   */
  private isWithinProjectDir(targetPath: string): boolean {
    if (!this.session.projectDir) return true // No boundary if no projectDir

    const normalized = path.resolve(targetPath)
    const projectDir = path.resolve(this.session.projectDir)

    // On Windows, both paths need to be on the same drive
    if (process.platform === 'win32') {
      const normalizedDrive = normalized.split(':')[0]?.toLowerCase()
      const projectDrive = projectDir.split(':')[0]?.toLowerCase()
      if (normalizedDrive !== projectDrive) {
        return false
      }
    }

    return normalized.startsWith(projectDir)
  }

  /**
   * Extract command signature (first token or first two tokens)
   */
  private extractCommandSignature(command: string): string {
    const tokens = command.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return ''

    // Skip environment variable assignments
    let index = 0
    while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
      index += 1
    }

    const trimmedTokens = tokens.slice(index)
    if (trimmedTokens.length === 0) return ''

    // Build signature: command [subcommand]
    const signatureTokens = [trimmedTokens[0]]
    if (trimmedTokens.length >= 2) {
      // If second token is a flag, include the third token
      if (trimmedTokens[1].startsWith('-') && trimmedTokens.length >= 3) {
        signatureTokens.push(trimmedTokens[2])
      } else if (!trimmedTokens[1].startsWith('-')) {
        // Otherwise, second token is likely a subcommand
        signatureTokens.push(trimmedTokens[1])
      }
    }

    return signatureTokens.join(' ')
  }

  /**
   * Safely parse JSON arguments
   */
  private safeParseArgs(args: string): Record<string, unknown> | null {
    try {
      return JSON.parse(args)
    } catch {
      return null
    }
  }

  /**
   * Find batch containing a request
   */
  private findBatchByRequestId(requestId: string): PermissionBatch | undefined {
    for (const batch of this.pendingBatches.values()) {
      if (batch.requests.some((r) => r.id === requestId)) {
        return batch
      }
    }
    return undefined
  }
}
