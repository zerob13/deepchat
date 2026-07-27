export const normalizeModelIdText = (value: string | null | undefined): string =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/^models\//, '') ?? ''

export const getUnqualifiedModelId = (value: string | null | undefined): string => {
  const normalizedModelId = normalizeModelIdText(value)
  return normalizedModelId.includes('/')
    ? normalizedModelId.slice(normalizedModelId.lastIndexOf('/') + 1)
    : normalizedModelId
}

export const getDottedProviderUnqualifiedModelId = (value: string | null | undefined): string => {
  const normalizedModelId = getUnqualifiedModelId(value)
  const segments = normalizedModelId.split('.')
  const modelSegmentIndex = segments.findIndex((segment) => segment.includes('-'))

  return modelSegmentIndex > 0 ? segments.slice(modelSegmentIndex).join('.') : normalizedModelId
}

export const normalizeCanonicalModelId = (value: string | null | undefined): string =>
  getDottedProviderUnqualifiedModelId(value)
    .replace(/[_:\s]+/g, '-')
    .replace(/(\d)\.(?=\d)/g, '$1-')
    .replace(/-+/g, '-')
