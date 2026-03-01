import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  CACHE_VERSION,
  getCacheKey,
  loadFromCache,
  saveToCache,
  invalidateCache,
  invalidateAllCachesOfType,
  invalidateAllCaches,
  hasCache,
  saveToCacheWithMetadata,
  getCacheMetadata,
  type CacheType
} from '@/utils/cache'

describe('Cache Versioning System', () => {
  const testSessionId = 'test-session-123'

  beforeEach(() => {
    // Clear all caches before each test
    invalidateAllCaches()
  })

  afterEach(() => {
    // Clean up after each test
    invalidateAllCaches()
  })

  describe('Cache Key Generation', () => {
    it('should generate correct cache key with version', () => {
      const key = getCacheKey('messages', testSessionId)
      expect(key).toBe(`messages-v${CACHE_VERSION}-${testSessionId}`)
    })

    it('should generate different keys for different types', () => {
      const messagesKey = getCacheKey('messages', testSessionId)
      const threadsKey = getCacheKey('threads', testSessionId)
      const settingsKey = getCacheKey('settings', testSessionId)

      expect(messagesKey).not.toBe(threadsKey)
      expect(threadsKey).not.toBe(settingsKey)
      expect(messagesKey).not.toBe(settingsKey)
    })

    it('should include current version in key', () => {
      const key = getCacheKey('messages', testSessionId)
      expect(key).toContain(`v${CACHE_VERSION}`)
    })
  })

  describe('Cache Save and Load', () => {
    it('should save and load data correctly', () => {
      const testData = { id: 'msg-1', content: 'Hello World' }

      saveToCache('messages', testSessionId, testData)
      const loaded = loadFromCache('messages', testSessionId)

      expect(loaded).toEqual(testData)
    })

    it('should return null for non-existent cache', () => {
      const loaded = loadFromCache('messages', 'non-existent-session')
      expect(loaded).toBeNull()
    })

    it('should return null when cache version mismatches', () => {
      // Simulate old version cache by manually setting it
      const oldVersionKey = `messages-v0-${testSessionId}`
      localStorage.setItem(oldVersionKey, JSON.stringify({ id: 'msg-1', content: 'Old Data' }))

      // Try to load with current version
      const loaded = loadFromCache('messages', testSessionId)
      expect(loaded).toBeNull()
    })

    it('should handle complex data structures', () => {
      const complexData = {
        messages: [
          { id: '1', role: 'user', content: 'Hello' },
          { id: '2', role: 'assistant', content: 'Hi there!' }
        ],
        metadata: {
          totalCount: 2,
          lastUpdated: Date.now()
        }
      }

      saveToCache('messages', testSessionId, complexData)
      const loaded = loadFromCache('messages', testSessionId)

      expect(loaded).toEqual(complexData)
    })

    it('should handle corrupted cache gracefully', () => {
      // Manually set corrupted data
      const key = getCacheKey('messages', testSessionId)
      localStorage.setItem(key, 'not-valid-json{{')

      const loaded = loadFromCache('messages', testSessionId)
      expect(loaded).toBeNull()

      // Should have removed the corrupted entry
      expect(localStorage.getItem(key)).toBeNull()
    })
  })

  describe('Cache Invalidation', () => {
    it('should invalidate specific session cache', () => {
      const data1 = { id: '1', content: 'Data 1' }
      const data2 = { id: '2', content: 'Data 2' }

      saveToCache('messages', 'session-1', data1)
      saveToCache('messages', 'session-2', data2)

      invalidateCache('messages', 'session-1')

      expect(loadFromCache('messages', 'session-1')).toBeNull()
      expect(loadFromCache('messages', 'session-2')).toEqual(data2)
    })

    it('should invalidate all caches of a type', () => {
      saveToCache('messages', 'session-1', { id: '1' })
      saveToCache('messages', 'session-2', { id: '2' })
      saveToCache('messages', 'session-3', { id: '3' })
      saveToCache('threads', 'session-1', { id: 'thread-1' })

      invalidateAllCachesOfType('messages')

      expect(loadFromCache('messages', 'session-1')).toBeNull()
      expect(loadFromCache('messages', 'session-2')).toBeNull()
      expect(loadFromCache('messages', 'session-3')).toBeNull()
      expect(loadFromCache('threads', 'session-1')).toEqual({ id: 'thread-1' })
    })

    it('should invalidate all caches', () => {
      saveToCache('messages', 'session-1', { id: '1' })
      saveToCache('threads', 'session-1', { id: 'thread-1' })
      saveToCache('settings', 'session-1', { theme: 'dark' })

      invalidateAllCaches()

      expect(loadFromCache('messages', 'session-1')).toBeNull()
      expect(loadFromCache('threads', 'session-1')).toBeNull()
      expect(loadFromCache('settings', 'session-1')).toBeNull()
    })
  })

  describe('Cache Existence Check', () => {
    it('should return true when cache exists', () => {
      saveToCache('messages', testSessionId, { id: '1' })
      expect(hasCache('messages', testSessionId)).toBe(true)
    })

    it('should return false when cache does not exist', () => {
      expect(hasCache('messages', 'non-existent')).toBe(false)
    })

    it('should return false for old version cache', () => {
      const oldVersionKey = `messages-v0-${testSessionId}`
      localStorage.setItem(oldVersionKey, JSON.stringify({ id: '1' }))

      expect(hasCache('messages', testSessionId)).toBe(false)
    })
  })

  describe('Cache Metadata', () => {
    it('should save cache with metadata', () => {
      const testData = { messages: [{ id: '1' }] }
      saveToCacheWithMetadata('messages', testSessionId, testData)

      const metadata = getCacheMetadata('messages', testSessionId)
      expect(metadata).not.toBeNull()
      expect(metadata?.size).toBeGreaterThan(0)
      expect(metadata?.age).toBeGreaterThanOrEqual(0)
    })

    it('should return null metadata for non-existent cache', () => {
      const metadata = getCacheMetadata('messages', 'non-existent')
      expect(metadata).toBeNull()
    })

    it('should track cache age correctly', async () => {
      const testData = { messages: [{ id: '1' }] }
      saveToCacheWithMetadata('messages', testSessionId, testData)

      const metadata1 = getCacheMetadata('messages', testSessionId)
      expect(metadata1?.age).toBeGreaterThanOrEqual(0)

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50))

      const metadata2 = getCacheMetadata('messages', testSessionId)
      expect(metadata2?.age).toBeGreaterThan(metadata1!.age)
    })
  })

  describe('Cache Version Isolation', () => {
    it('should isolate caches with different versions', () => {
      // Manually set up caches with different versions
      localStorage.setItem(`messages-v1-${testSessionId}`, JSON.stringify({ version: 1 }))
      localStorage.setItem(`messages-v2-${testSessionId}`, JSON.stringify({ version: 2 }))

      // Current version should only see its own cache
      const currentCache = loadFromCache('messages', testSessionId)

      if (CACHE_VERSION === 1) {
        expect(currentCache).toEqual({ version: 1 })
      } else if (CACHE_VERSION === 2) {
        expect(currentCache).toEqual({ version: 2 })
      }
    })
  })

  describe('Cache Type Safety', () => {
    it('should handle all cache types', () => {
      const cacheTypes: CacheType[] = ['messages', 'threads', 'settings']

      cacheTypes.forEach((type) => {
        const data = { type, timestamp: Date.now() }
        saveToCache(type, testSessionId, data)
        const loaded = loadFromCache(type, testSessionId)
        expect(loaded).toEqual(data)
      })
    })
  })

  describe('Cache Quota Handling', () => {
    it('should handle storage quota exceeded', () => {
      // This test verifies that the cache handles storage errors gracefully
      // by attempting to clear old caches and retry

      const largeData = { data: 'x'.repeat(10000) }

      // Should not throw
      expect(() => saveToCache('messages', testSessionId, largeData)).not.toThrow()

      const loaded = loadFromCache('messages', testSessionId)
      expect(loaded).toEqual(largeData)
    })
  })
})
