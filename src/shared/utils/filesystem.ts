const HARDLINK_UNAVAILABLE_CODES = new Set([
  'EACCES',
  'EINVAL',
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV'
])

export function isHardlinkUnavailableError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && HARDLINK_UNAVAILABLE_CODES.has(code)
}
