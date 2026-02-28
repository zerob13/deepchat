import path from 'path'
import fs from 'fs'

/**
 * Normalize a file path by resolving . and .. segments and symlinks
 * Returns the absolute, normalized path
 */
export function normalizePath(targetPath: string): string {
  if (!targetPath || targetPath.trim() === '') {
    return ''
  }

  try {
    // Resolve to absolute path (handles . and ..)
    let resolved = path.resolve(targetPath)

    // Try to resolve symlinks - security critical for preventing symlink escape attacks
    try {
      resolved = fs.realpathSync(resolved)
    } catch {
      // Path doesn't exist yet, attempt to resolve parent directory to prevent symlink escape
      const parentDir = path.dirname(resolved)
      try {
        const realParent = fs.realpathSync(parentDir)
        resolved = path.join(realParent, path.basename(resolved))
      } catch {
        // Parent directory also doesn't exist, use original resolved path
        // This is acceptable risk for deeply nested new paths
      }
    }

    // Normalize for platform (lowercase on Windows)
    if (process.platform === 'win32') {
      resolved = resolved.toLowerCase()
    }

    return resolved
  } catch (error) {
    console.error('[PathUtils] Failed to normalize path:', targetPath, error)
    return targetPath
  }
}

/**
 * Check if a child path is within a parent directory
 * Prevents directory traversal attacks (../ etc.)
 *
 * @param childPath - The path to check
 * @param parentPath - The parent directory that should contain childPath
 * @returns true if childPath is within parentPath, false otherwise
 */
export function isPathWithin(childPath: string, parentPath: string): boolean {
  if (!childPath || !parentPath) {
    return false
  }

  try {
    const normalizedChild = normalizePath(childPath)
    const normalizedParent = normalizePath(parentPath)

    if (!normalizedChild || !normalizedParent) {
      return false
    }

    // On Windows, ensure both paths use the same case
    const child = process.platform === 'win32' ? normalizedChild.toLowerCase() : normalizedChild
    const parent = process.platform === 'win32' ? normalizedParent.toLowerCase() : normalizedParent

    // Check if child starts with parent
    // Add path separator to prevent false positives like:
    // /home/user/project vs /home/user/project-secret
    const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep

    // Exact match or starts with parent + separator
    return child === parent || child.startsWith(parentWithSep)
  } catch (error) {
    console.error('[PathUtils] Failed to check path containment:', error)
    return false
  }
}

/**
 * Get the relative path from a base directory
 *
 * @param targetPath - The target path
 * @param baseDir - The base directory
 * @returns The relative path from baseDir to targetPath, or null if not possible
 */
export function getRelativePath(targetPath: string, baseDir: string): string | null {
  if (!targetPath || !baseDir) {
    return null
  }

  try {
    const normalizedTarget = normalizePath(targetPath)
    const normalizedBase = normalizePath(baseDir)

    if (!normalizedTarget || !normalizedBase) {
      return null
    }

    // Check if target is within base
    if (!isPathWithin(normalizedTarget, normalizedBase)) {
      return null
    }

    return path.relative(normalizedBase, normalizedTarget)
  } catch (error) {
    console.error('[PathUtils] Failed to get relative path:', error)
    return null
  }
}

/**
 * Validate that a path is safe to access
 * Checks for:
 * - Empty paths
 * - Path traversal attempts
 * - Paths outside the allowed boundary
 *
 * @param targetPath - The path to validate
 * @param allowedDir - The allowed directory boundary
 * @returns { valid: boolean, error?: string }
 */
export function validatePathAccess(
  targetPath: string,
  allowedDir: string
): { valid: boolean; error?: string } {
  if (!targetPath || targetPath.trim() === '') {
    return { valid: false, error: 'Path cannot be empty' }
  }

  if (!allowedDir) {
    return { valid: false, error: 'Allowed directory not specified' }
  }

  const normalizedPath = normalizePath(targetPath)
  const normalizedAllowed = normalizePath(allowedDir)

  if (!normalizedPath) {
    return { valid: false, error: 'Invalid path format' }
  }

  if (!isPathWithin(normalizedPath, normalizedAllowed)) {
    return {
      valid: false,
      error: `Access denied: Path "${normalizedPath}" is outside the allowed directory "${normalizedAllowed}"`
    }
  }

  return { valid: true }
}
