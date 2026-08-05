import { randomUUID } from 'node:crypto'
import {
  LOCAL_CONTROL_AGENT_TOKEN_ENV,
  createLocalControlFailure,
  type LocalControlDescriptor,
  type LocalControlRpcResponse
} from '@shared/contracts/localControl'
import { artifactsDescribeRoute } from '@shared/contracts/routes/artifacts.routes'
import { parseCliArguments, formatCliHelp, inferCliOutputMode, type CliOutputMode } from './args'
import {
  loadLocalControlDescriptor,
  selectLocalControlToken,
  type CliDiscoveryOptions
} from './discovery'
import {
  CLI_EXIT_CODES,
  CliClientError,
  CliUsageError,
  exitCodeForRemoteError,
  type CliExitCode
} from './errors'
import { formatHumanResult, serializeMachineResponse } from './format'
import { invokeLocalControlRpc, type CliRpcInvocation } from './transport'
import { downloadArtifact } from './artifacts'

const SIGNAL_GRACE_MS = 1_000

type WritableOutput = Pick<NodeJS.WriteStream, 'write'>
type SignalHost = Pick<NodeJS.Process, 'on' | 'off'>

export type CliRunDependencies = Readonly<{
  env?: NodeJS.ProcessEnv
  discovery?: Omit<CliDiscoveryOptions, 'env'>
  stdout?: WritableOutput
  stderr?: WritableOutput
  signalHost?: SignalHost
  randomId?: () => string
  loadDescriptor?: (options: CliDiscoveryOptions) => Promise<LocalControlDescriptor>
  invokeRpc?: (invocation: CliRpcInvocation) => Promise<LocalControlRpcResponse>
  forceExit?: (code: number) => void
}>

function writeText(output: WritableOutput, value: string): void {
  output.write(value.endsWith('\n') ? value : `${value}\n`)
}

function writeClientError(
  error: CliClientError,
  outputMode: CliOutputMode,
  requestId: string,
  stdout: WritableOutput,
  stderr: WritableOutput
): void {
  if (outputMode === 'text') {
    writeText(stderr, `${error.code}: ${error.message}`)
    return
  }
  writeText(
    stdout,
    serializeMachineResponse(
      createLocalControlFailure(requestId, {
        code: error.code,
        message: error.message,
        retriable: error.retriable
      })
    )
  )
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliRunDependencies = {}
): Promise<CliExitCode> {
  const env = dependencies.env ?? process.env
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  const signalHost = dependencies.signalHost ?? process
  const requestId = (dependencies.randomId ?? randomUUID)()

  let parsed
  try {
    parsed = parseCliArguments(argv, env)
  } catch (error) {
    const message = error instanceof CliUsageError ? error.message : 'Invalid CLI arguments'
    const outputMode = inferCliOutputMode(argv, env)
    if (outputMode === 'text') {
      writeText(stderr, message)
      writeText(stderr, 'Run: deepchat help commands')
    } else {
      writeClientError(
        new CliClientError('invalid_request', message, CLI_EXIT_CODES.usage),
        outputMode,
        requestId,
        stdout,
        stderr
      )
    }
    return CLI_EXIT_CODES.usage
  }

  if (parsed.helpRequested) {
    writeText(stdout, formatCliHelp(parsed))
    return CLI_EXIT_CODES.success
  }
  if (!parsed.contract) {
    writeText(stderr, 'CLI command is not implemented')
    return CLI_EXIT_CODES.internal
  }

  const controller = new AbortController()
  let forcedExitTimer: NodeJS.Timeout | undefined
  let timeout: NodeJS.Timeout | undefined
  let signalCount = 0
  const forceExit = dependencies.forceExit ?? ((code: number) => process.exit(code))
  const abortWith = (error: CliClientError) => {
    if (!controller.signal.aborted) controller.abort(error)
  }
  const onSignal = () => {
    signalCount += 1
    if (signalCount > 1) {
      forceExit(CLI_EXIT_CODES.cancelled)
      return
    }
    abortWith(
      new CliClientError('cancelled', 'CLI request was interrupted', CLI_EXIT_CODES.cancelled)
    )
    forcedExitTimer = setTimeout(() => forceExit(CLI_EXIT_CODES.cancelled), SIGNAL_GRACE_MS)
  }

  signalHost.on('SIGINT', onSignal)
  signalHost.on('SIGTERM', onSignal)
  timeout = setTimeout(() => {
    abortWith(
      new CliClientError('timeout', 'CLI request timed out', CLI_EXIT_CODES.cancelled, true)
    )
  }, parsed.timeoutMs)

  try {
    const descriptor = await (dependencies.loadDescriptor ?? loadLocalControlDescriptor)({
      ...dependencies.discovery,
      env
    })
    if (controller.signal.aborted) throw controller.signal.reason
    const token = selectLocalControlToken(descriptor, env)
    if (
      parsed.operation === 'download' &&
      Object.prototype.hasOwnProperty.call(env, LOCAL_CONTROL_AGENT_TOKEN_ENV)
    ) {
      throw new CliClientError(
        'permission_denied',
        'Agent callers cannot download artifact bytes or use --out',
        CLI_EXIT_CODES.authorization
      )
    }
    const invocationContract =
      parsed.operation === 'download' ? artifactsDescribeRoute : parsed.contract
    const response = await (dependencies.invokeRpc ?? invokeLocalControlRpc)({
      descriptor,
      token,
      id: requestId,
      method: invocationContract.name,
      params: parsed.params,
      signal: controller.signal
    })

    if (!response.ok) {
      if (parsed.outputMode === 'text') {
        writeText(stderr, `${response.error.code}: ${response.error.message}`)
      } else {
        writeText(stdout, serializeMachineResponse(response))
      }
      return exitCodeForRemoteError(response.error)
    }

    const result = parsed.contract.output.safeParse(response.result)
    if (!result.success) {
      throw new CliClientError(
        'internal_error',
        'DeepChat result did not match the command contract',
        CLI_EXIT_CODES.internal
      )
    }
    if (parsed.operation === 'download') {
      if (!parsed.outputPath || !('artifact' in result.data)) {
        throw new CliClientError(
          'internal_error',
          'Artifact download command has no validated output target',
          CLI_EXIT_CODES.internal
        )
      }
      await downloadArtifact({
        descriptor,
        token,
        metadata: result.data.artifact,
        outputPath: parsed.outputPath,
        overwrite: parsed.overwrite,
        signal: controller.signal
      })
    }
    if (parsed.outputMode === 'text') {
      writeText(
        stdout,
        formatHumanResult(parsed.contract, response.result, { outputPath: parsed.outputPath })
      )
    } else {
      writeText(stdout, serializeMachineResponse(response))
    }
    return CLI_EXIT_CODES.success
  } catch (error) {
    const clientError =
      error instanceof CliClientError
        ? error
        : new CliClientError(
            'internal_error',
            error instanceof Error ? error.message : 'Unexpected CLI failure',
            CLI_EXIT_CODES.internal
          )
    writeClientError(clientError, parsed.outputMode, requestId, stdout, stderr)
    return clientError.exitCode
  } finally {
    if (timeout) clearTimeout(timeout)
    if (forcedExitTimer) clearTimeout(forcedExitTimer)
    signalHost.off('SIGINT', onSignal)
    signalHost.off('SIGTERM', onSignal)
  }
}
