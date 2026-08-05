#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = path.resolve(scriptDirectory, '..')
export const cliOutputDirectory = path.join(repositoryRoot, 'out', 'cli')

export const POSIX_LAUNCHER = `#!/bin/sh
set -eu

script_path=$0
while [ -L "$script_path" ]; do
  script_dir=$(CDPATH= cd -P -- "$(dirname -- "$script_path")" && pwd)
  link_target=$(readlink "$script_path")
  case "$link_target" in
    /*) script_path=$link_target ;;
    *) script_path=$script_dir/$link_target ;;
  esac
done
script_dir=$(CDPATH= cd -P -- "$(dirname -- "$script_path")" && pwd)
exec "$script_dir/../runtime/node/bin/node" "$script_dir/deepchat.mjs" "$@"
`

export const WINDOWS_LAUNCHER = `@echo off\r
"%~dp0..\\runtime\\node\\node.exe" "%~dp0deepchat.mjs" %*\r
`

export async function buildCli(options = {}) {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  )
  const outDir = options.outDir ? path.resolve(options.outDir) : cliOutputDirectory

  await build({
    configFile: false,
    root: repositoryRoot,
    publicDir: false,
    resolve: {
      alias: {
        '@shared': path.join(repositoryRoot, 'src', 'shared')
      }
    },
    define: {
      __DEEPCHAT_CLI_VERSION__: JSON.stringify(packageJson.version)
    },
    build: {
      target: 'node24',
      outDir,
      emptyOutDir: true,
      copyPublicDir: false,
      minify: 'esbuild',
      lib: {
        entry: path.join(repositoryRoot, 'src', 'cli', 'index.ts'),
        formats: ['es']
      },
      rollupOptions: {
        external: [/^node:/],
        output: {
          format: 'es',
          entryFileNames: 'deepchat.mjs',
          inlineDynamicImports: true,
          banner: '#!/usr/bin/env node'
        }
      }
    },
    logLevel: options.logLevel ?? 'info'
  })

  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'deepchat'), POSIX_LAUNCHER, { mode: 0o755 })
  await chmod(path.join(outDir, 'deepchat'), 0o755)
  await writeFile(path.join(outDir, 'deepchat.cmd'), WINDOWS_LAUNCHER, 'utf8')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  buildCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
