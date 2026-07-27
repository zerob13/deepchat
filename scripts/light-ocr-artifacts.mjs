import path from 'node:path'

export const LIGHT_OCR_ARTIFACT_KINDS = Object.freeze({
  nativeCode: 'native-code',
  pdfiumCode: 'pdfium-code',
  pdfiumLoader: 'pdfium-loader',
  other: 'other'
})

const PDFIUM_ARTIFACTS_BY_PLATFORM = Object.freeze({
  darwin: Object.freeze([
    'pdfium/index.cjs',
    'pdfium/libpdfium.dylib',
    'pdfium/pdfium.node'
  ]),
  linux: Object.freeze(['pdfium/index.cjs', 'pdfium/libpdfium.so', 'pdfium/pdfium.node']),
  win32: Object.freeze(['pdfium/index.cjs', 'pdfium/pdfium.dll', 'pdfium/pdfium.node'])
})

const CODE_EXTENSIONS = new Set(['.dll', '.dylib', '.node', '.so'])
const MAC_CODE_EXTENSIONS = new Set(['.dylib', '.node'])

export function classifyLightOcrArtifact(relativePath) {
  if (relativePath === 'pdfium/index.cjs') return LIGHT_OCR_ARTIFACT_KINDS.pdfiumLoader
  const extension =
    typeof relativePath === 'string' ? path.posix.extname(relativePath).toLowerCase() : ''
  if (
    typeof relativePath === 'string' &&
    relativePath.startsWith('pdfium/') &&
    CODE_EXTENSIONS.has(extension)
  ) {
    return LIGHT_OCR_ARTIFACT_KINDS.pdfiumCode
  }
  if (
    typeof relativePath === 'string' &&
    relativePath.startsWith('native/') &&
    CODE_EXTENSIONS.has(extension)
  ) {
    return LIGHT_OCR_ARTIFACT_KINDS.nativeCode
  }
  return LIGHT_OCR_ARTIFACT_KINDS.other
}

export function isEncodedMacLightOcrArtifact(relativePath) {
  const kind = classifyLightOcrArtifact(relativePath)
  if (
    kind !== LIGHT_OCR_ARTIFACT_KINDS.nativeCode &&
    kind !== LIGHT_OCR_ARTIFACT_KINDS.pdfiumCode
  ) {
    return false
  }
  return MAC_CODE_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())
}

export function getRequiredPdfiumArtifactPaths(platform) {
  const paths = PDFIUM_ARTIFACTS_BY_PLATFORM[platform]
  if (!paths) throw new Error(`Unsupported Light OCR PDFium platform: ${String(platform)}`)
  return [...paths]
}

export function groupLightOcrArtifactPaths(relativePaths, platform) {
  const groups = {
    nativeCode: [],
    pdfiumCode: [],
    pdfiumLoader: [],
    other: []
  }
  const seen = new Set()
  for (const relativePath of relativePaths) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new Error('Light OCR artifact inventory contains an invalid path')
    }
    if (seen.has(relativePath)) {
      throw new Error(`Light OCR artifact inventory contains a duplicate path: ${relativePath}`)
    }
    seen.add(relativePath)
    const kind = classifyLightOcrArtifact(relativePath)
    if (kind === LIGHT_OCR_ARTIFACT_KINDS.nativeCode) groups.nativeCode.push(relativePath)
    else if (kind === LIGHT_OCR_ARTIFACT_KINDS.pdfiumCode) groups.pdfiumCode.push(relativePath)
    else if (kind === LIGHT_OCR_ARTIFACT_KINDS.pdfiumLoader) {
      groups.pdfiumLoader.push(relativePath)
    } else {
      groups.other.push(relativePath)
    }
  }

  for (const paths of Object.values(groups)) paths.sort()
  if (groups.nativeCode.length === 0) {
    throw new Error('Light OCR native artifact inventory contains no runtime code')
  }
  const expectedPdfiumPaths = getRequiredPdfiumArtifactPaths(platform).sort()
  const actualPdfiumPaths = [...seen].filter((relativePath) =>
    relativePath.startsWith('pdfium/')
  ).sort()
  if (
    expectedPdfiumPaths.length !== actualPdfiumPaths.length ||
    expectedPdfiumPaths.some((relativePath, index) => relativePath !== actualPdfiumPaths[index])
  ) {
    throw new Error(
      `Light OCR PDFium artifact inventory mismatch for ${platform}: expected ${expectedPdfiumPaths.join(', ')}`
    )
  }
  return groups
}
