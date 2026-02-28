import Database from 'better-sqlite3-multiple-ciphers'
import { BaseTable } from './baseTable'

export interface PermissionWhitelistRow {
  id: string
  session_id: string
  tool_name: string
  path_pattern: string
  created_at: number
}

export class PermissionWhitelistTable extends BaseTable {
  constructor(db: Database.Database) {
    super(db, 'permission_whitelist')
  }

  getCreateTableSQL(): string {
    return `
      CREATE TABLE IF NOT EXISTS permission_whitelist (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        path_pattern TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_permission_whitelist_session ON permission_whitelist(session_id);
      CREATE INDEX IF NOT EXISTS idx_permission_whitelist_session_tool ON permission_whitelist(session_id, tool_name);
    `
  }

  getMigrationSQL(_version: number): string | null {
    return null
  }

  getLatestVersion(): number {
    return 0
  }

  /**
   * Add a new whitelist rule
   */
  addRule(sessionId: string, toolName: string, pathPattern: string): string {
    const id = `wl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO permission_whitelist (id, session_id, tool_name, path_pattern, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, sessionId, toolName, pathPattern, now)
    return id
  }

  /**
   * Remove a whitelist rule by ID
   */
  removeRule(ruleId: string): boolean {
    const result = this.db.prepare('DELETE FROM permission_whitelist WHERE id = ?').run(ruleId)
    return result.changes > 0
  }

  /**
   * Remove all whitelist rules for a session
   */
  removeSessionRules(sessionId: string): number {
    const result = this.db
      .prepare('DELETE FROM permission_whitelist WHERE session_id = ?')
      .run(sessionId)
    return result.changes
  }

  /**
   * Get all whitelist rules for a session
   */
  getSessionRules(sessionId: string): PermissionWhitelistRow[] {
    return this.db
      .prepare('SELECT * FROM permission_whitelist WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as PermissionWhitelistRow[]
  }

  /**
   * Get whitelist rules for a session and tool
   */
  getSessionToolRules(sessionId: string, toolName: string): PermissionWhitelistRow[] {
    return this.db
      .prepare(
        'SELECT * FROM permission_whitelist WHERE session_id = ? AND tool_name = ? ORDER BY created_at DESC'
      )
      .all(sessionId, toolName) as PermissionWhitelistRow[]
  }

  /**
   * Check if a path matches any whitelist rule for the given session and tool
   * Supports exact match and glob patterns (* and **)
   */
  matchesWhitelist(sessionId: string, toolName: string, path: string): boolean {
    const rules = this.getSessionToolRules(sessionId, toolName)

    for (const rule of rules) {
      if (this.pathMatchesPattern(path, rule.path_pattern)) {
        return true
      }
    }

    return false
  }

  private pathMatchesPattern(targetPath: string, pattern: string): boolean {
    if (targetPath === pattern) {
      return true
    }

    let regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '___DOUBLE_STAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/___DOUBLE_STAR___/g, '.*')

    const regex = new RegExp(`^${regexPattern}$`)
    return regex.test(targetPath)
  }
}
