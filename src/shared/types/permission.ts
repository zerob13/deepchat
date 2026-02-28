/**
 * Permission Types for AgentPresenter
 *
 * Defines permission modes, whitelist rules, and permission requests
 * for fine-grained access control.
 */

export type PermissionMode = 'default' | 'full'

export interface PermissionWhitelistRule {
  id: string
  sessionId: string
  toolName: string
  pathPattern: string
  createdAt: number
}

export interface PermissionRequest {
  id: string
  sessionId: string
  toolName: string
  path: string
  action: 'read' | 'write' | 'execute'
  status: 'pending' | 'allowed' | 'denied'
}

export interface FilePermissionRequest {
  toolName: string
  serverName: string
  permissionType: 'read' | 'write' | 'all'
  path: string
  action: 'read' | 'write' | 'execute'
  sessionId?: string
  rememberable?: boolean
}

export class FilePermissionRequiredError extends Error {
  readonly permissionRequest: FilePermissionRequest

  constructor(permissionRequest: FilePermissionRequest) {
    super('File permission required')
    this.permissionRequest = permissionRequest
  }
}
