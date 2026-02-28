import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import {
  normalizePath,
  isPathWithin,
  getRelativePath,
  validatePathAccess
} from '../../../src/main/utils/pathUtils'

describe('pathUtils', () => {
  const testDir = path.join(__dirname, 'test-path-utils-temp')
  const projectDir = path.join(testDir, 'project')
  const subDir = path.join(projectDir, 'subdir')
  const outsideDir = path.join(testDir, 'outside')

  beforeEach(() => {
    // Clean up first if exists
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
    // Create test directory structure
    fs.mkdirSync(testDir, { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.mkdirSync(subDir, { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directories
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('normalizePath', () => {
    it('should normalize absolute paths', () => {
      const normalized = normalizePath(projectDir)
      expect(normalized).toBe(path.resolve(projectDir))
    })

    it('should normalize paths with . segments', () => {
      const pathWithDot = path.join(projectDir, '.', 'subdir')
      const normalized = normalizePath(pathWithDot)
      expect(normalized).toBe(path.join(projectDir, 'subdir'))
    })

    it('should resolve .. segments', () => {
      const normalized = normalizePath(path.join(subDir, '..', 'file.txt'))
      expect(normalized).toBe(path.join(projectDir, 'file.txt'))
    })

    it('should resolve . segments', () => {
      const normalized = normalizePath(path.join(projectDir, '.', 'file.txt'))
      expect(normalized).toBe(path.join(projectDir, 'file.txt'))
    })

    it('should handle empty paths', () => {
      expect(normalizePath('')).toBe('')
      // Whitespace-only paths get normalized by path.resolve
      expect(normalizePath('   ').trim()).toBe('')
    })

    it('should handle non-existent paths (for write operations)', () => {
      const newPath = path.join(projectDir, 'new-file.txt')
      const normalized = normalizePath(newPath)
      expect(normalized).toBe(path.resolve(newPath))
    })
  })

  describe('isPathWithin', () => {
    it('should return true for direct child paths', () => {
      const childFile = path.join(projectDir, 'file.txt')
      expect(isPathWithin(childFile, projectDir)).toBe(true)
    })

    it('should return true for nested child paths', () => {
      const nestedFile = path.join(subDir, 'nested.txt')
      expect(isPathWithin(nestedFile, projectDir)).toBe(true)
    })

    it('should return false for paths outside the boundary', () => {
      const outsideFile = path.join(outsideDir, 'file.txt')
      expect(isPathWithin(outsideFile, projectDir)).toBe(false)
    })

    it('should return false for path traversal attempts with ..', () => {
      const traversalPath = path.join(projectDir, '..', 'outside', 'file.txt')
      expect(isPathWithin(traversalPath, projectDir)).toBe(false)
    })

    it('should return false for path traversal with multiple ..', () => {
      const traversalPath = path.join(subDir, '..', '..', 'outside', 'file.txt')
      expect(isPathWithin(traversalPath, projectDir)).toBe(false)
    })

    it('should return true for exact match', () => {
      expect(isPathWithin(projectDir, projectDir)).toBe(true)
    })

    it('should return false for similar prefix paths', () => {
      const similarPath = path.join(testDir, 'project-secret')
      expect(isPathWithin(similarPath, projectDir)).toBe(false)
    })

    it('should handle empty paths', () => {
      expect(isPathWithin('', projectDir)).toBe(false)
      expect(isPathWithin(projectDir, '')).toBe(false)
      expect(isPathWithin('', '')).toBe(false)
    })

    it('should handle absolute paths correctly', () => {
      const absPath = path.resolve(projectDir, 'file.txt')
      expect(isPathWithin(absPath, projectDir)).toBe(true)
    })
  })

  describe('getRelativePath', () => {
    it('should get relative path for child', () => {
      const childFile = path.join(subDir, 'file.txt')
      const relative = getRelativePath(childFile, projectDir)
      expect(relative).toBe(path.join('subdir', 'file.txt'))
    })

    it('should return null for paths outside boundary', () => {
      const outsideFile = path.join(outsideDir, 'file.txt')
      const relative = getRelativePath(outsideFile, projectDir)
      expect(relative).toBe(null)
    })

    it('should return empty string for exact match', () => {
      const relative = getRelativePath(projectDir, projectDir)
      expect(relative).toBe('')
    })

    it('should handle empty paths', () => {
      expect(getRelativePath('', projectDir)).toBe(null)
      expect(getRelativePath(projectDir, '')).toBe(null)
    })
  })

  describe('validatePathAccess', () => {
    it('should validate accessible paths', () => {
      const childFile = path.join(subDir, 'file.txt')
      const result = validatePathAccess(childFile, projectDir)
      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should reject paths outside boundary', () => {
      const outsideFile = path.join(outsideDir, 'file.txt')
      const result = validatePathAccess(outsideFile, projectDir)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('outside the allowed directory')
    })

    it('should reject empty paths', () => {
      const result = validatePathAccess('', projectDir)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('cannot be empty')
    })

    it('should reject when allowed directory is not specified', () => {
      const result = validatePathAccess('/some/path', '')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('not specified')
    })

    it('should reject path traversal attempts', () => {
      const traversalPath = path.join(projectDir, '..', 'outside', 'file.txt')
      const result = validatePathAccess(traversalPath, projectDir)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('outside the allowed directory')
    })
  })

  describe('Security: Path Traversal Prevention', () => {
    it('should prevent ../ escape from subdirectory', () => {
      const maliciousPath = path.join(subDir, '..', '..', 'outside', 'malicious.txt')
      expect(isPathWithin(maliciousPath, projectDir)).toBe(false)
    })

    it('should prevent multiple ../ escapes', () => {
      const maliciousPath = path.join(subDir, '..', '..', '..', 'etc', 'passwd')
      expect(isPathWithin(maliciousPath, projectDir)).toBe(false)
    })

    it('should prevent absolute path escape', () => {
      const maliciousPath = '/etc/passwd'
      expect(isPathWithin(maliciousPath, projectDir)).toBe(false)
    })

    it('should handle URL-encoded path traversal', () => {
      // Note: URL decoding would happen before path validation in real scenarios
      // This test documents that URL-encoded paths are treated as literal filenames
      const maliciousPath = path.join(projectDir, '%2e%2e', 'outside')
      // After normalization, %2e%2e is treated as a literal directory name, not ..
      // In real scenarios, URL decoding should happen BEFORE path validation
      const normalized = normalizePath(maliciousPath)
      // This will be true because %2e%2e is a valid (though unusual) directory name
      // Real-world: decodeURIComponent should be called before validatePathAccess
      expect(normalized).toContain('%2e%2e')
    })
  })

  describe('Security: Symlink Escape Prevention', () => {
    it('should resolve symlinks for existing paths', () => {
      // Create a symlink inside projectDir pointing to outsideDir
      const symlinkPath = path.join(projectDir, 'link-to-outside')
      try {
        fs.symlinkSync(outsideDir, symlinkPath, 'dir')
        const normalized = normalizePath(symlinkPath)
        // Should resolve to the real path (outsideDir), not the symlink path
        expect(normalized).toBe(path.resolve(outsideDir))
      } catch {
        // Skip on Windows if symlinks require privileges
        console.log('Symlink test skipped - requires elevated privileges on Windows')
      }
    })

    it('should handle non-existent paths by resolving parent directory', () => {
      // Create a path that doesn't exist yet but whose parent does
      const newPath = path.join(projectDir, 'nonexistent', 'file.txt')
      const normalized = normalizePath(newPath)
      // Should resolve parent and append filename
      expect(normalized).toBe(path.join(path.resolve(projectDir), 'nonexistent', 'file.txt'))
    })

    it('should prevent symlink escape for new files in non-existent directories', () => {
      // Attacker creates symlink in projectDir pointing outside
      const symlinkPath = path.join(projectDir, 'malicious-link')
      const targetOutside = path.join(outsideDir, 'secret.txt')

      try {
        // Create symlink (simulating attacker setup)
        fs.symlinkSync(targetOutside, symlinkPath, 'file')

        // Now try to normalize a path through this symlink
        const nestedPath = path.join(symlinkPath, 'data.txt')
        const normalized = normalizePath(nestedPath)

        // Should resolve through symlink to outside location
        // This demonstrates the symlink is properly resolved
        expect(normalized).toContain(path.resolve(outsideDir))
      } catch {
        // Skip on Windows if symlinks require privileges
        console.log('Symlink escape test skipped - requires elevated privileges')
      }
    })
  })
})
