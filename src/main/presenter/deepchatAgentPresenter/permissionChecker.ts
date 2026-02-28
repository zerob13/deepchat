import { presenter } from '@/presenter'
import { isPathWithin, normalizePath } from '@/utils/pathUtils'
import type { FilePermissionRequest } from '@shared/types/permission'
import type { SessionWithState } from '@shared/types/agent-interface'

/**
 * Check if a file operation requires permission
 */
export async function checkFilePermission(
  sessionId: string,
  toolName: string,
  filePath: string,
  action: 'read' | 'write' | 'execute'
): Promise<
  { requiresPermission: true; request: FilePermissionRequest } | { requiresPermission: false }
> {
  const session = await presenter.newAgentPresenter.getSession(sessionId)

  if (!session) {
    return { requiresPermission: false }
  }

  return checkFilePermissionForSession(session, toolName, filePath, action)
}

function checkFilePermissionForSession(
  session: SessionWithState,
  toolName: string,
  filePath: string,
  action: 'read' | 'write' | 'execute'
): { requiresPermission: true; request: FilePermissionRequest } | { requiresPermission: false } {
  const permissionMode = session.permissionMode || 'default'
  const projectDir = session.projectDir

  if (permissionMode === 'full') {
    if (projectDir) {
      const normalizedPath = normalizePath(filePath)
      const isWithin = isPathWithin(normalizedPath, normalizePath(projectDir))

      if (!isWithin) {
        throw new Error(
          `Access denied in full access mode: Path "${normalizedPath}" is outside the session workspace "${projectDir}"`
        )
      }
      return { requiresPermission: false }
    }
    return { requiresPermission: false }
  }

  if (permissionMode === 'default') {
    const permissionType: 'read' | 'write' | 'all' =
      action === 'read' ? 'read' : action === 'write' ? 'write' : 'all'

    return {
      requiresPermission: true,
      request: {
        toolName,
        serverName: 'agent-filesystem',
        permissionType,
        path: filePath,
        action,
        sessionId: session.id,
        rememberable: true
      }
    }
  }

  return { requiresPermission: false }
}

/**
 * Add a path to the whitelist (called when user selects "Allow Always")
 */
export async function addToWhitelist(
  sessionId: string,
  toolName: string,
  pathPattern: string
): Promise<string> {
  return presenter.newAgentPresenter.addToWhitelist(sessionId, toolName, pathPattern)
}

/**
 * Get all whitelist rules for a session
 */
export async function getWhitelist(sessionId: string): Promise<
  Array<{
    id: string
    sessionId: string
    toolName: string
    pathPattern: string
    createdAt: number
  }>
> {
  return presenter.newAgentPresenter.getWhitelist(sessionId)
}

/**
 * Remove a whitelist rule
 */
export async function removeFromWhitelist(sessionId: string, ruleId: string): Promise<boolean> {
  return presenter.newAgentPresenter.removeFromWhitelist(sessionId, ruleId)
}
