import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import Database from 'better-sqlite3-multiple-ciphers'
import { PermissionWhitelistTable } from '../../../src/main/presenter/sqlitePresenter/tables/permissionWhitelist'

describe('PermissionWhitelistTable', () => {
  let db: Database.Database
  let whitelistTable: PermissionWhitelistTable
  const testDbPath = path.join(__dirname, 'test-permission-whitelist.db')

  beforeEach(() => {
    // Clean up old test database if exists
    try {
      fs.unlinkSync(testDbPath)
    } catch {
      // Ignore
    }

    // Create in-memory database for testing
    db = new Database(testDbPath)
    whitelistTable = new PermissionWhitelistTable(db)

    // Initialize table
    const createSQL = whitelistTable.getCreateTableSQL()
    db.exec(createSQL)
  })

  afterEach(() => {
    db.close()
    // Clean up test database
    try {
      fs.unlinkSync(testDbPath)
    } catch {
      // Ignore
    }
  })

  describe('pathMatchesPattern', () => {
    it('should match exact paths', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      const pattern = '/home/user/project/file.txt'

      whitelistTable.addRule(sessionId, toolName, pattern)

      // Should match exact path
      expect(whitelistTable.matchesWhitelist(sessionId, toolName, pattern)).toBe(true)
    })

    it('should match glob patterns with *', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      const pattern = '/home/user/project/*.txt'

      whitelistTable.addRule(sessionId, toolName, pattern)

      expect(
        whitelistTable.matchesWhitelist(sessionId, toolName, '/home/user/project/file.txt')
      ).toBe(true)
      expect(
        whitelistTable.matchesWhitelist(sessionId, toolName, '/home/user/project/test.txt')
      ).toBe(true)
      expect(
        whitelistTable.matchesWhitelist(sessionId, toolName, '/home/user/project/file.md')
      ).toBe(false)
    })

    it('should match glob patterns with **', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      const pattern = '/home/user/project/**'

      whitelistTable.addRule(sessionId, toolName, pattern)

      expect(
        whitelistTable.matchesWhitelist(sessionId, toolName, '/home/user/project/file.txt')
      ).toBe(true)
      expect(
        whitelistTable.matchesWhitelist(sessionId, toolName, '/home/user/project/subdir/file.txt')
      ).toBe(true)
      expect(
        whitelistTable.matchesWhitelist(sessionId, toolName, '/home/user/project/a/b/c/file.txt')
      ).toBe(true)
      expect(
        whitelistTable.matchesWhitelist(sessionId, toolName, '/home/user/other/file.txt')
      ).toBe(false)
    })

    it('should normalize paths before matching to prevent ../ bypass', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      const pattern = '/home/user/project/file.txt'

      whitelistTable.addRule(sessionId, toolName, pattern)

      // Attempt to bypass with ../ in path
      const bypassAttempt = '/home/user/project/../project/file.txt'

      // Should normalize and match
      expect(whitelistTable.matchesWhitelist(sessionId, toolName, bypassAttempt)).toBe(true)
    })

    it('should prevent path traversal bypass in whitelist matching', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      // Whitelist only allows files in project dir
      const pattern = '/home/user/project/**'

      whitelistTable.addRule(sessionId, toolName, pattern)

      // Attempt to escape with ../
      const escapePath = '/home/user/project/../../etc/passwd'

      // After normalization, this should NOT match the whitelist
      // because it resolves to /etc/passwd which is outside /home/user/project
      expect(whitelistTable.matchesWhitelist(sessionId, toolName, escapePath)).toBe(false)
    })

    it('should handle paths with . segments', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      const pattern = '/home/user/project/file.txt'

      whitelistTable.addRule(sessionId, toolName, pattern)

      // Path with . segment should normalize and match
      const pathWithDot = '/home/user/project/./file.txt'
      expect(whitelistTable.matchesWhitelist(sessionId, toolName, pathWithDot)).toBe(true)
    })

    it('should handle complex path traversal attempts', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      const pattern = '/home/user/project/safe/**'

      whitelistTable.addRule(sessionId, toolName, pattern)

      // Multiple traversal attempts
      const maliciousPath = '/home/user/project/safe/../../secret/file.txt'
      expect(whitelistTable.matchesWhitelist(sessionId, toolName, maliciousPath)).toBe(false)
    })
  })

  describe('addRule and getSessionToolRules', () => {
    it('should add and retrieve whitelist rules', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      const pattern = '/home/user/project/**'

      const ruleId = whitelistTable.addRule(sessionId, toolName, pattern)

      expect(ruleId).toBeDefined()
      expect(ruleId.startsWith('wl_')).toBe(true)

      const rules = whitelistTable.getSessionToolRules(sessionId, toolName)
      expect(rules.length).toBe(1)
      expect(rules[0].path_pattern).toBe(pattern)
    })

    it('should remove rules', () => {
      const sessionId = 'test-session'
      const toolName = 'read_file'
      const pattern = '/home/user/project/**'

      const ruleId = whitelistTable.addRule(sessionId, toolName, pattern)

      const removed = whitelistTable.removeRule(ruleId)
      expect(removed).toBe(true)

      const rules = whitelistTable.getSessionToolRules(sessionId, toolName)
      expect(rules.length).toBe(0)
    })

    it('should remove all session rules', () => {
      const sessionId = 'test-session'

      whitelistTable.addRule(sessionId, 'read_file', '/home/user/project/**')
      whitelistTable.addRule(sessionId, 'write_file', '/home/user/project/**')
      whitelistTable.addRule(sessionId, 'read_file', '/home/user/other/**')

      const changes = whitelistTable.removeSessionRules(sessionId)
      expect(changes).toBe(3)
    })
  })
})
