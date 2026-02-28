import { presenter } from '@/presenter'
import { isPathWithin, normalizePath, validatePathAccess } from '@/utils/pathUtils'
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
 * Check if a tool call requires permission (generic version for any tool)
 * This is the main entry point for T3/T4 permission integration
 */
export async function checkToolPermission(
  sessionId: string,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<
  | {
      requiresPermission: true
      request: FilePermissionRequest
    }
  | { requiresPermission: false }
> {
  const session = await presenter.newAgentPresenter.getSession(sessionId)

  if (!session) {
    return { requiresPermission: false }
  }

  const permissionMode = session.permissionMode || 'default'
  const projectDir = session.projectDir

  // Extract path from tool args (common pattern for file tools)
  const filePath = extractPathFromArgs(toolArgs)

  if (permissionMode === 'full') {
    // Full access mode: only restrict to projectDir if set
    if (projectDir && filePath) {
      const accessResult = validatePathAccess(filePath, projectDir)
      if (!accessResult.valid) {
        throw new Error(accessResult.error)
      }
    }
    return { requiresPermission: false }
  }

  if (permissionMode === 'default') {
    // Check whitelist first
    if (filePath) {
      const isWhitelisted = await presenter.newAgentPresenter.checkWhitelist(
        sessionId,
        toolName,
        filePath
      )
      if (isWhitelisted) {
        return { requiresPermission: false }
      }
    }

    // Determine permission type based on tool name
    const permissionType = determinePermissionType(toolName, toolArgs)

    // Return permission request - this will trigger frontend permission prompt
    return {
      requiresPermission: true,
      request: {
        toolName,
        serverName: 'agent-filesystem', // Default to filesystem, can be overridden
        permissionType,
        path: filePath || '',
        action: permissionType === 'read' ? 'read' : 'write',
        sessionId: session.id,
        rememberable: true
      }
    }
  }

  return { requiresPermission: false }
}

/**
 * Extract path from tool arguments (supports common patterns)
 * Exported for testing
 */
export function extractPathFromArgs(args: Record<string, unknown>): string | null {
  // Direct path argument
  if (typeof args.path === 'string' && args.path.trim()) {
    return args.path
  }

  // File argument
  if (typeof args.file === 'string' && args.file.trim()) {
    return args.file
  }

  // Files array (first item)
  if (Array.isArray(args.files) && args.files.length > 0) {
    const firstFile = args.files[0]
    if (typeof firstFile === 'string') {
      return firstFile
    }
  }

  // Directory argument
  if (typeof args.directory === 'string' && args.directory.trim()) {
    return args.directory
  }

  // Dir argument
  if (typeof args.dir === 'string' && args.dir.trim()) {
    return args.dir
  }

  return null
}

/**
 * Determine permission type based on tool name and arguments
 * Exported for testing
 */
export function determinePermissionType(
  toolName: string,
  args: Record<string, unknown>
): 'read' | 'write' | 'all' {
  // Write operations
  const writeTools = ['write_file', 'writeFile', 'create_file', 'append_file', 'move_file']
  if (writeTools.some((t) => toolName.toLowerCase().includes(t.toLowerCase()))) {
    return 'write'
  }

  // Read operations
  const readTools = ['read_file', 'readFile', 'list_directory', 'search_files']
  if (readTools.some((t) => toolName.toLowerCase().includes(t.toLowerCase()))) {
    return 'read'
  }

  // Check for write-related args
  if (args.content !== undefined || args.data !== undefined || args.text !== undefined) {
    return 'write'
  }

  // Default to 'all' for unknown tools
  return 'all'
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
