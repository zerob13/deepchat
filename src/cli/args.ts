import {
  cliCapabilitiesRoute,
  cliDoctorRoute,
  cliStatusRoute,
  cliVersionRoute
} from '@shared/contracts/routes/cli.routes'
import {
  ArtifactIdSchema,
  artifactsDeleteRoute,
  artifactsDescribeRoute,
  artifactsReadRoute
} from '@shared/contracts/routes/artifacts.routes'
import type { JsonValue } from '@shared/contracts/json'
import { CliUsageError } from './errors'

export const CLI_OUTPUT_ENV = 'DEEPCHAT_CLI_OUTPUT'
export const CLI_TIMEOUT_ENV = 'DEEPCHAT_CLI_TIMEOUT_MS'
export const DEFAULT_CLI_TIMEOUT_MS = 30_000
export const MAX_CLI_TIMEOUT_MS = 30 * 60_000

export type CliOutputMode = 'text' | 'json' | 'jsonl'
export type CliRpcContract =
  | typeof cliStatusRoute
  | typeof cliVersionRoute
  | typeof cliCapabilitiesRoute
  | typeof cliDoctorRoute
  | typeof artifactsDescribeRoute
  | typeof artifactsReadRoute
  | typeof artifactsDeleteRoute

export type CliCommandOperation = 'rpc' | 'download'

export type ParsedCliArguments = Readonly<{
  domain: string
  verb: string
  contract: CliRpcContract | null
  outputMode: CliOutputMode
  timeoutMs: number
  helpRequested: boolean
  operation: CliCommandOperation
  params: JsonValue
  outputPath?: string
  overwrite: boolean
}>

const COMMANDS = new Map<string, CliRpcContract>([
  ['system status', cliStatusRoute],
  ['system version', cliVersionRoute],
  ['system capabilities', cliCapabilitiesRoute],
  ['system doctor', cliDoctorRoute],
  ['artifact describe', artifactsDescribeRoute],
  ['artifact get', artifactsReadRoute],
  ['artifact delete', artifactsDeleteRoute]
])

function parseOutputMode(value: string | undefined): CliOutputMode {
  if (value === undefined || value.trim() === '') return 'text'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'text' || normalized === 'json' || normalized === 'jsonl') return normalized
  throw new CliUsageError(`${CLI_OUTPUT_ENV} must be text, json, or jsonl`)
}

export function inferCliOutputMode(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): CliOutputMode {
  if (!argv[0] || !argv[1] || argv[0].startsWith('-') || argv[1].startsWith('-')) return 'text'
  const explicit = argv.slice(2).find((argument) => argument === '--json' || argument === '--jsonl')
  if (explicit) return explicit.slice(2) as CliOutputMode
  try {
    return parseOutputMode(env[CLI_OUTPUT_ENV])
  } catch {
    return 'text'
  }
}

function parseTimeout(value: string, source: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliUsageError(`${source} must be a positive integer in milliseconds`)
  }
  const timeoutMs = Number(value)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_CLI_TIMEOUT_MS) {
    throw new CliUsageError(`${source} must not exceed ${MAX_CLI_TIMEOUT_MS}`)
  }
  return timeoutMs
}

export function parseCliArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): ParsedCliArguments {
  const domain = argv[0]
  const verb = argv[1]
  if (!domain || !verb || domain.startsWith('-') || verb.startsWith('-')) {
    throw new CliUsageError('Expected: deepchat <domain> <verb> [options]')
  }

  const commandKey = `${domain} ${verb}`
  const isHelpCommand = commandKey === 'help commands'
  const contract = COMMANDS.get(commandKey) ?? null
  if (!contract && !isHelpCommand) {
    throw new CliUsageError(`Unknown command: deepchat ${domain} ${verb}`)
  }

  let outputMode = parseOutputMode(env[CLI_OUTPUT_ENV])
  let explicitOutputMode: CliOutputMode | undefined
  let timeoutMs = env[CLI_TIMEOUT_ENV]
    ? parseTimeout(env[CLI_TIMEOUT_ENV], CLI_TIMEOUT_ENV)
    : DEFAULT_CLI_TIMEOUT_MS
  let timeoutSeen = false
  let helpRequested = false
  let artifactId: string | undefined
  let outputPath: string | undefined
  let overwrite = false

  const readOptionValue = (
    argument: string,
    index: number
  ): { value: string; nextIndex: number } => {
    const equalsIndex = argument.indexOf('=')
    if (equalsIndex >= 0) {
      const value = argument.slice(equalsIndex + 1)
      if (!value) throw new CliUsageError(`Missing value for ${argument.slice(0, equalsIndex)}`)
      return { value, nextIndex: index }
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new CliUsageError(`Missing value for ${argument}`)
    }
    return { value, nextIndex: index + 1 }
  }

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json' || argument === '--jsonl') {
      const nextMode = argument.slice(2) as CliOutputMode
      if (explicitOutputMode && explicitOutputMode !== nextMode) {
        throw new CliUsageError('--json and --jsonl are mutually exclusive')
      }
      explicitOutputMode = nextMode
      outputMode = nextMode
      continue
    }
    if (argument === '--help') {
      if (helpRequested) throw new CliUsageError('--help may be specified only once')
      helpRequested = true
      continue
    }
    if (argument === '--timeout') {
      if (timeoutSeen) throw new CliUsageError('--timeout may be specified only once')
      const value = argv[index + 1]
      if (!value) throw new CliUsageError('Missing value for --timeout')
      timeoutMs = parseTimeout(value, '--timeout')
      timeoutSeen = true
      index += 1
      continue
    }
    if (argument.startsWith('--timeout=')) {
      if (timeoutSeen) throw new CliUsageError('--timeout may be specified only once')
      timeoutMs = parseTimeout(argument.slice('--timeout='.length), '--timeout')
      timeoutSeen = true
      continue
    }
    if (argument === '--id' || argument.startsWith('--id=')) {
      if (artifactId !== undefined) throw new CliUsageError('--id may be specified only once')
      const parsedOption = readOptionValue(argument, index)
      const parsedId = ArtifactIdSchema.safeParse(parsedOption.value)
      if (!parsedId.success) throw new CliUsageError('--id is not a valid artifact identifier')
      artifactId = parsedId.data
      index = parsedOption.nextIndex
      continue
    }
    if (argument === '--out' || argument.startsWith('--out=')) {
      if (outputPath !== undefined) throw new CliUsageError('--out may be specified only once')
      const parsedOption = readOptionValue(argument, index)
      outputPath = parsedOption.value
      index = parsedOption.nextIndex
      continue
    }
    if (argument === '--overwrite') {
      if (overwrite) throw new CliUsageError('--overwrite may be specified only once')
      overwrite = true
      continue
    }
    throw new CliUsageError(`Unknown option after ${domain} ${verb}: ${argument}`)
  }

  const isArtifactCommand = domain === 'artifact'
  if (!helpRequested && isArtifactCommand && !artifactId) {
    throw new CliUsageError(`deepchat ${domain} ${verb} requires --id <artifact-id>`)
  }
  if (!helpRequested && commandKey === 'artifact get' && !outputPath) {
    throw new CliUsageError('deepchat artifact get requires --out <path>')
  }
  if (!isArtifactCommand && (artifactId !== undefined || outputPath !== undefined || overwrite)) {
    throw new CliUsageError(`Artifact options are not valid for deepchat ${domain} ${verb}`)
  }
  if (
    isArtifactCommand &&
    commandKey !== 'artifact get' &&
    (outputPath !== undefined || overwrite)
  ) {
    throw new CliUsageError(`--out and --overwrite are only valid for deepchat artifact get`)
  }

  return {
    domain,
    verb,
    contract,
    outputMode,
    timeoutMs,
    helpRequested: helpRequested || isHelpCommand,
    operation: commandKey === 'artifact get' ? 'download' : 'rpc',
    params: artifactId ? { id: artifactId } : {},
    ...(outputPath ? { outputPath } : {}),
    overwrite
  }
}

export function formatCliHelp(command?: Pick<ParsedCliArguments, 'domain' | 'verb'>): string {
  if (command && command.domain !== 'help') {
    const commandOptions =
      command.domain === 'artifact'
        ? command.verb === 'get'
          ? ' --id <artifact-id> --out <path> [--overwrite]'
          : ' --id <artifact-id>'
        : ''
    return [
      `Usage: deepchat ${command.domain} ${command.verb}${commandOptions} [--json|--jsonl] [--timeout <ms>]`,
      '',
      'Global flags must follow the domain and verb.'
    ].join('\n')
  }

  return [
    'Usage: deepchat <domain> <verb> [options]',
    '',
    'Commands:',
    '  system status        Show local control-plane status',
    '  system version       Show app and protocol versions',
    '  system capabilities  List the exposed CLI surface',
    '  system doctor        Run local transport diagnostics',
    '  artifact describe    Show owned artifact metadata',
    '  artifact get         Download an owned artifact',
    '  artifact delete      Delete an owned artifact',
    '  help commands        Show this help',
    '',
    'Options (after domain and verb):',
    '  --json               Emit one JSON result envelope',
    '  --jsonl              Emit JSONL records',
    '  --timeout <ms>       Set request timeout',
    '  --help               Show command usage'
  ].join('\n')
}
