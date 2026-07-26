export interface MemoryDomainClock {
  now(): number
  timeZone(): string
}

function resolveSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const SYSTEM_TIME_ZONE = resolveSystemTimeZone()

export const systemMemoryDomainClock: MemoryDomainClock = {
  now: () => Date.now(),
  timeZone: () => SYSTEM_TIME_ZONE
}
