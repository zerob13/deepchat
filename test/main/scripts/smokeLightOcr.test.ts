import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, default: actual }
})

import {
  assertSupportExpectation,
  assertFixtureRecognized,
  createPackagedLightOcrEnvironment,
  measurePackagedComponents,
  normalizeArch,
  normalizePlatform,
  parseArgs,
  resolvePackagedOcrLayout
} from '../../../scripts/smoke-light-ocr.js'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const runtimeVersions = {
  node: 'v24.14.1',
  nodeArtifacts: {
    'darwin-arm64': {
      executableSha256: sha256('node')
    },
    'linux-arm64': {
      executableSha256: sha256('node')
    }
  },
  lightOcr: {
    facadeVersion: '0.5.5',
    runtimePackage: '@arcships/light-ocr-runtime',
    runtimeVersion: '0.1.5',
    bundleId: 'ppocrv6-small-native-20260719.1',
    modelPackage: '@arcships/light-ocr-model-ppocrv6-small',
    modelVersion: '0.3.4',
    nativeVersion: '0.5.5',
    nativePackages: {
      'darwin-arm64': '@arcships/light-ocr-darwin-arm64',
      'darwin-x64': '@arcships/light-ocr-darwin-x64',
      'linux-arm64': '@arcships/light-ocr-linux-arm64-gnu',
      'linux-x64': '@arcships/light-ocr-linux-x64-gnu',
      'win32-arm64': '@arcships/light-ocr-win32-arm64',
      'win32-x64': '@arcships/light-ocr-win32-x64'
    }
  }
}

const darwinNativeInventory = {
  nativeCode: ['native/addon.node'],
  pdfiumCode: ['pdfium/libpdfium.dylib', 'pdfium/pdfium.node'],
  pdfiumLoader: ['pdfium/index.cjs'],
  other: ['native/runtime-descriptor.json']
}

const linuxNativeInventory = {
  nativeCode: ['native/addon.node'],
  pdfiumCode: ['pdfium/libpdfium.so', 'pdfium/pdfium.node'],
  pdfiumLoader: ['pdfium/index.cjs'],
  other: ['native/runtime-descriptor.json']
}

async function writeTree(root: string, files: Record<string, string>) {
  for (const [relativePath, body] of Object.entries(files)) {
    const filePath = path.join(root, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, body)
  }
}

describe('smoke-light-ocr', () => {
  let tempDir: string
  let resourcesPath: string
  let unpackedRoot: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'deepchat-ocr-smoke-test-'))
    resourcesPath = path.join(tempDir, 'resources')
    unpackedRoot = path.join(resourcesPath, 'app.asar.unpacked')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('parses strict target and threshold arguments', () => {
    expect(
      parseArgs([
        '--resources-path',
        '/app/resources',
        '--platform=macos',
        '--arch',
        'aarch64',
        '--expect-supported',
        '--require-execution'
      ])
    ).toEqual({
      'resources-path': '/app/resources',
      platform: 'macos',
      arch: 'aarch64',
      'expect-supported': true,
      'require-execution': true
    })
    expect(normalizePlatform('macos')).toBe('darwin')
    expect(normalizeArch('amd64')).toBe('x64')
    expect(() => parseArgs(['--resources-path'])).toThrow(/Missing value/)
    expect(() => parseArgs(['--unknown', 'value'])).toThrow(/Unknown/)
  })

  it('requires an independent support expectation for executable smoke', () => {
    expect(() =>
      assertSupportExpectation({ 'expect-supported': true, 'require-execution': true }, true)
    ).not.toThrow()
    expect(() => assertSupportExpectation({ 'expect-supported': true }, false)).toThrow(
      /expected to be supported/
    )
    expect(() => assertSupportExpectation({ 'expect-unsupported': true }, true)).toThrow(
      /expected to be unsupported/
    )
    expect(() => assertSupportExpectation({ 'require-execution': true }, true)).toThrow(
      /requires --expect-supported/
    )
    expect(() => assertSupportExpectation({ 'require-peak-rss': true }, true)).toThrow(
      /requires --require-execution/
    )
    expect(() =>
      assertSupportExpectation(
        { 'expect-supported': true, 'expect-unsupported': true },
        true
      )
    ).toThrow(/mutually exclusive/)
  })

  it('does not inherit credentials or code-injection variables in smoke helpers', () => {
    expect(
      createPackagedLightOcrEnvironment({
        PATH: '/usr/bin',
        TEMP: '/tmp',
        GITHUB_TOKEN: 'secret',
        HTTP_PROXY: 'http://credentials@example.com',
        NODE_OPTIONS: '--require malicious.js',
        LD_PRELOAD: '/tmp/injected.so',
        LIGHT_OCR_PDFIUM_MODULE: '/tmp/injected.cjs'
      })
    ).toEqual({
      PATH: '/usr/bin',
      TEMP: '/tmp',
      DEEPCHAT_LIGHT_OCR_HELPER: '1',
      DEEPCHAT_LIGHT_OCR_OFFLINE_SMOKE: '1'
    })
  })

  it('validates identities and checksums for a supported packaged target', async () => {
    const facadeDir = path.join(unpackedRoot, 'node_modules/@arcships/light-ocr')
    const runtimeDir = path.join(unpackedRoot, 'node_modules/@arcships/light-ocr-runtime')
    const modelDir = path.join(
      unpackedRoot,
      'node_modules/@arcships/light-ocr-model-ppocrv6-small'
    )
    const nativeDir = path.join(unpackedRoot, 'node_modules/@arcships/light-ocr-darwin-arm64')
    const modelManifest = JSON.stringify({ bundleId: runtimeVersions.lightOcr.bundleId })
    const modelPayload = 'model-payload'
    const nativePayload = 'native-payload'
    const nativeDescriptor = '{}'
    const pdfiumLoader = 'module.exports = require("./pdfium.node")'
    const pdfiumAddon = 'pdfium-addon'
    const pdfiumLibrary = 'pdfium-library'

    await writeTree(unpackedRoot, {
      'runtime/node/bin/node': 'node',
      'out/main/lightOcrHelper.js': 'helper',
      'node_modules/@arcships/light-ocr/package.json': JSON.stringify({
        name: '@arcships/light-ocr',
        version: '0.5.5',
        dependencies: {
          '@arcships/light-ocr-runtime': '0.1.5',
          '@arcships/light-ocr-model-ppocrv6-small': '0.3.4'
        }
      }),
      'node_modules/@arcships/light-ocr/src/index.cjs': 'module.exports = {}',
      'node_modules/@arcships/light-ocr-runtime/package.json': JSON.stringify({
        name: '@arcships/light-ocr-runtime',
        version: '0.1.5',
        optionalDependencies: {
          '@arcships/light-ocr-darwin-arm64': '0.5.5'
        }
      }),
      'node_modules/@arcships/light-ocr-runtime/src/index.cjs': 'module.exports = {}',
      'node_modules/@arcships/light-ocr-model-ppocrv6-small/package.json': JSON.stringify({
        name: runtimeVersions.lightOcr.modelPackage,
        version: '0.3.4'
      }),
      'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle/manifest.json': modelManifest,
      'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle/model.bin': modelPayload,
      'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle/SHA256SUMS': [
        `${sha256(modelManifest)}  manifest.json`,
        `${sha256(modelPayload)}  model.bin`
      ].join('\n'),
      'node_modules/@arcships/light-ocr-darwin-arm64/package.json': JSON.stringify({
        name: '@arcships/light-ocr-darwin-arm64',
        version: '0.5.5'
      }),
      'node_modules/@arcships/light-ocr-darwin-arm64/native/addon.node.gz.b64': gzipSync(
        nativePayload
      ).toString('base64'),
      'node_modules/@arcships/light-ocr-darwin-arm64/native/runtime-descriptor.json':
        nativeDescriptor,
      'node_modules/@arcships/light-ocr-darwin-arm64/pdfium/index.cjs': pdfiumLoader,
      'node_modules/@arcships/light-ocr-darwin-arm64/pdfium/pdfium.node.gz.b64': gzipSync(
        pdfiumAddon
      ).toString('base64'),
      'node_modules/@arcships/light-ocr-darwin-arm64/pdfium/libpdfium.dylib.gz.b64':
        gzipSync(pdfiumLibrary).toString('base64'),
      'node_modules/@arcships/light-ocr-darwin-arm64/artifact-hashes.json': JSON.stringify({
        files: [
          {
            path: 'native/addon.node',
            bytes: Buffer.byteLength(nativePayload),
            sha256: sha256(nativePayload)
          },
          {
            path: 'native/runtime-descriptor.json',
            bytes: Buffer.byteLength(nativeDescriptor),
            sha256: sha256(nativeDescriptor)
          },
          {
            path: 'pdfium/index.cjs',
            bytes: Buffer.byteLength(pdfiumLoader),
            sha256: sha256(pdfiumLoader)
          },
          {
            path: 'pdfium/libpdfium.dylib',
            bytes: Buffer.byteLength(pdfiumLibrary),
            sha256: sha256(pdfiumLibrary)
          },
          {
            path: 'pdfium/pdfium.node',
            bytes: Buffer.byteLength(pdfiumAddon),
            sha256: sha256(pdfiumAddon)
          }
        ]
      }),
      'runtime/ocr/manifest.json': JSON.stringify({
        schemaVersion: 3,
        supported: true,
        platform: 'darwin',
        arch: 'arm64',
        facadeVersion: '0.5.5',
        runtimeVersion: '0.1.5',
        modelVersion: '0.3.4',
        nativeVersion: '0.5.5',
        pdfSupport: true,
        bundleId: runtimeVersions.lightOcr.bundleId,
        nodeVersion: runtimeVersions.node,
        nodeSha256: runtimeVersions.nodeArtifacts['darwin-arm64'].executableSha256,
        nativePackage: '@arcships/light-ocr-darwin-arm64',
        nativePayloadEncoding: 'gzip-base64-v1',
        nativeArtifactInventory: darwinNativeInventory,
        paths: {
          node: 'runtime/node/bin/node',
          helper: 'out/main/lightOcrHelper.js',
          facade: 'node_modules/@arcships/light-ocr',
          runtime: 'node_modules/@arcships/light-ocr-runtime',
          bundle: 'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle',
          native: 'node_modules/@arcships/light-ocr-darwin-arm64'
        }
      })
    })

    const layout = await resolvePackagedOcrLayout({
      resourcesPath,
      platform: 'darwin',
      arch: 'arm64',
      runtimeVersions
    })

    expect(layout).toMatchObject({
      supported: true,
      facadeDir,
      runtimeDir,
      modelPackageDir: modelDir,
      nativePackageDir: nativeDir,
      nativePayloadEncoding: 'gzip-base64-v1',
      nativePackage: '@arcships/light-ocr-darwin-arm64'
    })

    await writeTree(unpackedRoot, {
      'runtime/uv/uv': 'uv-runtime',
      'runtime/rtk/rtk': 'rtk-runtime',
      'runtime/duckdb/extensions/vss': 'existing-duckdb'
    })
    const components = await measurePackagedComponents(layout)
    expect(components.nodeRuntime.unpackedBytes).toBe(Buffer.byteLength('node'))
    expect(components.otherRuntime.unpackedBytes).toBe(
      Buffer.byteLength('uv-runtime') + Buffer.byteLength('rtk-runtime')
    )
    expect(Object.keys(components.otherRuntime.entries)).toEqual(['rtk', 'uv'])
    expect(components.ocrAssets.unpackedBytes).toBeGreaterThan(0)

    if (process.platform !== 'win32') {
      const npmLink = path.join(unpackedRoot, 'runtime/node/bin/npm')
      await writeTree(unpackedRoot, { 'runtime/node/lib/npm.js': 'npm-runtime' })
      await symlink('../lib/npm.js', npmLink)
      const withInternalLink = await measurePackagedComponents(layout)
      expect(withInternalLink.nodeRuntime.unpackedBytes).toBe(
        Buffer.byteLength('node') + Buffer.byteLength('npm-runtime')
      )

      await rm(npmLink)
      const externalTarget = path.join(tempDir, 'external-runtime')
      await writeFile(externalTarget, 'not-packaged')
      await symlink(externalTarget, npmLink)
      await expect(measurePackagedComponents(layout)).rejects.toThrow(/escapes its measured root/)
    }

    const verifySignature = vi.fn().mockResolvedValue(undefined)
    await writeTree(unpackedRoot, {
      'runtime/node/bin/node': 'signed-node'
    })
    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'darwin',
        arch: 'arm64',
        runtimeVersions,
        verifySignature
      })
    ).resolves.toMatchObject({ supported: true })
    expect(verifySignature).toHaveBeenCalledOnce()
    expect(path.relative(unpackedRoot, verifySignature.mock.calls[0][0])).toBe(
      'runtime/node/bin/node'
    )

    await writeTree(unpackedRoot, {
      'node_modules/@arcships/light-ocr-darwin-arm64/pdfium/unexpected.node': 'unmanifested'
    })
    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'darwin',
        arch: 'arm64',
        runtimeVersions,
        verifySignature
      })
    ).rejects.toThrow(/PDFium directory mismatch/)
    await rm(
      path.join(
        unpackedRoot,
        'node_modules/@arcships/light-ocr-darwin-arm64/pdfium/unexpected.node'
      )
    )

    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'darwin',
        arch: 'arm64',
        runtimeVersions,
        verifySignature: vi.fn().mockRejectedValue(new Error('invalid code signature'))
      })
    ).rejects.toThrow(/invalid code signature/)

    verifySignature.mockClear()
    await writeTree(unpackedRoot, {
      'runtime/node/bin/node': 'node',
      'node_modules/@arcships/light-ocr-darwin-arm64/native/runtime-descriptor.json':
        'signed-metadata'
    })
    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'darwin',
        arch: 'arm64',
        runtimeVersions,
        verifySignature
      })
    ).rejects.toThrow(/size mismatch/)
    expect(verifySignature).not.toHaveBeenCalled()

    await writeTree(unpackedRoot, {
      'node_modules/@arcships/light-ocr-darwin-arm64/native/runtime-descriptor.json':
        nativeDescriptor,
      'node_modules/@arcships/light-ocr-darwin-arm64/native/addon.node.gz.b64': 'invalid'
    })
    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'darwin',
        arch: 'arm64',
        runtimeVersions,
        verifySignature
      })
    ).rejects.toThrow(/canonical base64/)

    await writeTree(unpackedRoot, {
      'node_modules/@arcships/light-ocr-darwin-arm64/native/addon.node.gz.b64': gzipSync(
        nativePayload
      ).toString('base64'),
      'node_modules/@arcships/light-ocr-darwin-arm64/native/addon.node': nativePayload
    })
    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'darwin',
        arch: 'arm64',
        runtimeVersions,
        verifySignature
      })
    ).rejects.toThrow(/still contains raw native code/)
  })

  it('validates the direct Linux arm64 native payload', async () => {
    const modelManifest = JSON.stringify({ bundleId: runtimeVersions.lightOcr.bundleId })
    const modelPayload = 'model-payload'
    const nativePayload = 'native-payload'
    const nativeDescriptor = '{}'
    const nativePackage = '@arcships/light-ocr-linux-arm64-gnu'
    const pdfiumLoader = 'module.exports = require("./pdfium.node")'
    const pdfiumAddon = 'pdfium-addon'
    const pdfiumLibrary = 'pdfium-library'

    await writeTree(unpackedRoot, {
      'runtime/node/bin/node': 'node',
      'out/main/lightOcrHelper.js': 'helper',
      'node_modules/@arcships/light-ocr/package.json': JSON.stringify({
        name: '@arcships/light-ocr',
        version: '0.5.5',
        dependencies: {
          '@arcships/light-ocr-runtime': '0.1.5',
          '@arcships/light-ocr-model-ppocrv6-small': '0.3.4'
        }
      }),
      'node_modules/@arcships/light-ocr/src/index.cjs': 'module.exports = {}',
      'node_modules/@arcships/light-ocr-runtime/package.json': JSON.stringify({
        name: '@arcships/light-ocr-runtime',
        version: '0.1.5',
        optionalDependencies: { [nativePackage]: '0.5.5' }
      }),
      'node_modules/@arcships/light-ocr-runtime/src/index.cjs': 'module.exports = {}',
      'node_modules/@arcships/light-ocr-model-ppocrv6-small/package.json': JSON.stringify({
        name: runtimeVersions.lightOcr.modelPackage,
        version: '0.3.4'
      }),
      'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle/manifest.json': modelManifest,
      'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle/model.bin': modelPayload,
      'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle/SHA256SUMS': [
        `${sha256(modelManifest)}  manifest.json`,
        `${sha256(modelPayload)}  model.bin`
      ].join('\n'),
      [`node_modules/${nativePackage}/package.json`]: JSON.stringify({
        name: nativePackage,
        version: '0.5.5'
      }),
      [`node_modules/${nativePackage}/native/addon.node`]: nativePayload,
      [`node_modules/${nativePackage}/native/runtime-descriptor.json`]: nativeDescriptor,
      [`node_modules/${nativePackage}/pdfium/index.cjs`]: pdfiumLoader,
      [`node_modules/${nativePackage}/pdfium/pdfium.node`]: pdfiumAddon,
      [`node_modules/${nativePackage}/pdfium/libpdfium.so`]: pdfiumLibrary,
      [`node_modules/${nativePackage}/artifact-hashes.json`]: JSON.stringify({
        files: [
          {
            path: 'native/addon.node',
            bytes: Buffer.byteLength(nativePayload),
            sha256: sha256(nativePayload)
          },
          {
            path: 'native/runtime-descriptor.json',
            bytes: Buffer.byteLength(nativeDescriptor),
            sha256: sha256(nativeDescriptor)
          },
          {
            path: 'pdfium/index.cjs',
            bytes: Buffer.byteLength(pdfiumLoader),
            sha256: sha256(pdfiumLoader)
          },
          {
            path: 'pdfium/libpdfium.so',
            bytes: Buffer.byteLength(pdfiumLibrary),
            sha256: sha256(pdfiumLibrary)
          },
          {
            path: 'pdfium/pdfium.node',
            bytes: Buffer.byteLength(pdfiumAddon),
            sha256: sha256(pdfiumAddon)
          }
        ]
      }),
      'runtime/ocr/manifest.json': JSON.stringify({
        schemaVersion: 3,
        supported: true,
        platform: 'linux',
        arch: 'arm64',
        facadeVersion: '0.5.5',
        runtimeVersion: '0.1.5',
        modelVersion: '0.3.4',
        nativeVersion: '0.5.5',
        pdfSupport: true,
        bundleId: runtimeVersions.lightOcr.bundleId,
        nodeVersion: runtimeVersions.node,
        nodeSha256: runtimeVersions.nodeArtifacts['linux-arm64'].executableSha256,
        nativePackage,
        nativePayloadEncoding: 'direct',
        nativeArtifactInventory: linuxNativeInventory,
        paths: {
          node: 'runtime/node/bin/node',
          helper: 'out/main/lightOcrHelper.js',
          facade: 'node_modules/@arcships/light-ocr',
          runtime: 'node_modules/@arcships/light-ocr-runtime',
          bundle: 'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle',
          native: `node_modules/${nativePackage}`
        }
      })
    })

    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'linux',
        arch: 'arm64',
        runtimeVersions
      })
    ).resolves.toMatchObject({
      supported: true,
      nativePayloadEncoding: 'direct',
      nativePackage
    })
  })

  it('rejects a manifest path that escapes the packaged app root', async () => {
    await writeTree(unpackedRoot, {
      'runtime/ocr/manifest.json': JSON.stringify({
        schemaVersion: 3,
        supported: true,
        platform: 'darwin',
        arch: 'arm64',
        facadeVersion: '0.5.5',
        runtimeVersion: '0.1.5',
        modelVersion: '0.3.4',
        nativeVersion: '0.5.5',
        pdfSupport: true,
        bundleId: runtimeVersions.lightOcr.bundleId,
        nodeVersion: runtimeVersions.node,
        nodeSha256: runtimeVersions.nodeArtifacts['darwin-arm64'].executableSha256,
        nativePackage: '@arcships/light-ocr-darwin-arm64',
        nativePayloadEncoding: 'gzip-base64-v1',
        nativeArtifactInventory: darwinNativeInventory,
        paths: {
          node: '../node',
          helper: 'out/main/lightOcrHelper.js',
          facade: 'node_modules/@arcships/light-ocr',
          runtime: 'node_modules/@arcships/light-ocr-runtime',
          bundle: 'node_modules/@arcships/light-ocr-model-ppocrv6-small/bundle',
          native: 'node_modules/@arcships/light-ocr-darwin-arm64'
        }
      })
    })

    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'darwin',
        arch: 'arm64',
        runtimeVersions
      })
    ).rejects.toThrow(/escapes/)
  })

  it('accepts unsupported targets only when OCR executable assets are absent', async () => {
    await writeTree(unpackedRoot, {
      'runtime/ocr/manifest.json': JSON.stringify({
        schemaVersion: 3,
        supported: false,
        reason: 'unsupported_platform',
        platform: 'win32',
        arch: 'ia32',
        facadeVersion: '0.5.5',
        runtimeVersion: '0.1.5',
        modelVersion: '0.3.4',
        nativeVersion: '0.5.5',
        pdfSupport: false,
        bundleId: runtimeVersions.lightOcr.bundleId
      })
    })

    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'win32',
        arch: 'ia32',
        runtimeVersions
      })
    ).resolves.toMatchObject({ supported: false })

    await writeTree(unpackedRoot, { 'out/main/lightOcrHelper.js': 'helper' })
    await expect(
      resolvePackagedOcrLayout({
        resourcesPath,
        platform: 'win32',
        arch: 'ia32',
        runtimeVersions
      })
    ).rejects.toThrow(/still contains the helper/)
  })

  it('requires stable fixture anchors without exposing recognized text', () => {
    expect(() =>
      assertFixtureRecognized({ lines: [{ text: 'DeepChat' }, { text: 'OCR TEST 2026' }] })
    ).not.toThrow()
    expect(() => assertFixtureRecognized({ lines: [{ text: 'unrelated' }] })).toThrow(
      /did not recognize/
    )
  })
})
