/**
 * Cache Version Management
 *
 * Bump CACHE_VERSION when:
 * - Message schema changes
 * - Cache structure changes
 * - Virtual scroll logic changes
 * - Breaking changes to message data
 *
 * Version History:
 * - v1 (2026-03-01): Initial version with session-based caching for messages
 *
 * When bumping version:
 * 1. Update CACHE_VERSION constant
 * 2. Update this changelog
 * 3. Test cache invalidation
 * 4. Document in changelog
 */

// Cache version - bump when cache schema changes
export const CACHE_VERSION = 1

// Cache types supported
export type CacheType = 'messages' | 'threads' | 'settings'

/**
 * Generate a versioned cache key
 * Format: {type}-v{version}-{sessionId}
 */
export function getCacheKey(type: CacheType, sessionId: string): string {
  return `${type}-v${CACHE_VERSION}-${sessionId}`
}

/**
 * Load data from cache with version checking
 * Returns null if cache doesn't exist or version mismatch
 */
export function loadFromCache<T>(type: CacheType, sessionId: string): T | null {
  const key = getCacheKey(type, sessionId)
  const data = localStorage.getItem(key)

  if (!data) return null

  try {
    return JSON.parse(data) as T
  } catch (error) {
    // Cache corrupted, invalidate
    console.warn(`[Cache] Failed to parse cache for ${key}, removing corrupted entry`)
    localStorage.removeItem(key)
    return null
  }
}

/**
 * Save data to cache with current version
 */
export function saveToCache<T>(type: CacheType, sessionId: string, data: T): void {
  const key = getCacheKey(type, sessionId)
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch (error) {
    // Handle quota exceeded or other storage errors
    console.error(`[Cache] Failed to save cache for ${key}:`, error)
    // Try to clear old caches and retry
    invalidateAllCachesOfType(type)
    try {
      localStorage.setItem(key, JSON.stringify(data))
    } catch (retryError) {
      console.error(`[Cache] Failed to save cache even after cleanup:`, retryError)
    }
  }
}

/**
 * Invalidate cache for a specific session
 */
export function invalidateCache(type: CacheType, sessionId: string): void {
  const key = getCacheKey(type, sessionId)
  localStorage.removeItem(key)
}

/**
 * Invalidate all caches of a specific type with current version
 */
export function invalidateAllCachesOfType(type: CacheType): void {
  const prefix = `${type}-v${CACHE_VERSION}-`
  const keysToRemove: string[] = []

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(prefix)) {
      keysToRemove.push(key)
    }
  }

  keysToRemove.forEach((key) => localStorage.removeItem(key))
}

/**
 * Invalidate all caches (useful for logout/reset)
 */
export function invalidateAllCaches(): void {
  const versionedCachePattern = /^[a-z]+-v\d+-.+$/
  const keysToRemove: string[] = []

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && versionedCachePattern.test(key)) {
      keysToRemove.push(key)
    }
  }

  keysToRemove.forEach((key) => localStorage.removeItem(key))
}

/**
 * Check if cache exists for a session
 */
export function hasCache(type: CacheType, sessionId: string): boolean {
  const key = getCacheKey(type, sessionId)
  return localStorage.getItem(key) !== null
}

/**
 * Get cache metadata (size, age)
 */
export function getCacheMetadata(
  type: CacheType,
  sessionId: string
): { size: number; age: number } | null {
  const key = getCacheKey(type, sessionId)
  const data = localStorage.getItem(key)

  if (!data) return null

  // Get item timestamp from a companion key if available
  const timestampKey = `${key}__meta`
  const timestampData = localStorage.getItem(timestampKey)
  const timestamp = timestampData ? parseInt(timestampData, 10) : Date.now()

  return {
    size: new Blob([data]).size,
    age: Date.now() - timestamp
  }
}

/**
 * Save cache with metadata (includes timestamp)
 */
export function saveToCacheWithMetadata<T>(type: CacheType, sessionId: string, data: T): void {
  saveToCache(type, sessionId, data)

  // Save timestamp metadata
  const key = getCacheKey(type, sessionId)
  const timestampKey = `${key}__meta`
  localStorage.setItem(timestampKey, Date.now().toString())
}
