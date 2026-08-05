import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from './run'

export { parseCliArguments, formatCliHelp } from './args'
export { downloadArtifact } from './artifacts'
export { loadLocalControlDescriptor, resolveCliUserDataPath } from './discovery'
export { CLI_EXIT_CODES } from './errors'
export { runCli } from './run'
export { CLI_VERSION, invokeLocalControlRpc } from './transport'

function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
    process.exit(8)
  })
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false
  try {
    return (
      realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (isDirectExecution()) {
  ignoreBrokenPipe(process.stdout)
  ignoreBrokenPipe(process.stderr)
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
