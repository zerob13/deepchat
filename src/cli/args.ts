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
import {
  AUDIO_TRANSCRIPTION_MAX_INPUT_BYTES,
  audioTranscribeArtifactRoute,
  audioTranscribeUploadRoute
} from '@shared/contracts/routes/audio.routes'
import { modelsInvokeRoute } from '@shared/contracts/routes/models.routes'
import {
  imagesGenerateRoute,
  speechGenerateRoute,
  videosGenerateRoute
} from '@shared/contracts/routes/media.routes'
import { providersListPublicRoute } from '@shared/contracts/routes/providers.routes'
import {
  OCR_EXTRACTION_MAX_INPUT_BYTES,
  ocrClearCacheRoute,
  ocrExtractArtifactRoute,
  ocrExtractUploadRoute,
  ocrGetRuntimeStatusRoute
} from '@shared/contracts/routes/ocr.routes'
import {
  settingsGetPublicRoute,
  settingsUpdatePublicRoute
} from '@shared/contracts/routes/settings.routes'
import { JsonValueSchema, type JsonValue } from '@shared/contracts/json'
import { LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS } from '@shared/contracts/localControl'
import {
  ATTACHMENT_PDF_OCR_MAX_TOKENS,
  PDF_PAGE_COUNT_SANITY_LIMIT
} from '@shared/types/attachment'
import path from 'node:path'
import { CliUsageError } from './errors'

export const CLI_OUTPUT_ENV = 'DEEPCHAT_CLI_OUTPUT'
export const CLI_TIMEOUT_ENV = 'DEEPCHAT_CLI_TIMEOUT_MS'
export const DEFAULT_CLI_TIMEOUT_MS = 30_000
export const MAX_CLI_TIMEOUT_MS = LOCAL_CONTROL_MAX_REQUEST_TIMEOUT_MS
export const DEFAULT_COMPUTE_TIMEOUT_MS = MAX_CLI_TIMEOUT_MS

export type CliOutputMode = 'text' | 'json' | 'jsonl'
export type CliRpcContract =
  | typeof cliStatusRoute
  | typeof cliVersionRoute
  | typeof cliCapabilitiesRoute
  | typeof cliDoctorRoute
  | typeof artifactsDescribeRoute
  | typeof artifactsReadRoute
  | typeof artifactsDeleteRoute
  | typeof modelsInvokeRoute
  | typeof imagesGenerateRoute
  | typeof videosGenerateRoute
  | typeof speechGenerateRoute
  | typeof audioTranscribeUploadRoute
  | typeof audioTranscribeArtifactRoute
  | typeof ocrGetRuntimeStatusRoute
  | typeof ocrExtractUploadRoute
  | typeof ocrExtractArtifactRoute
  | typeof ocrClearCacheRoute
  | typeof providersListPublicRoute
  | typeof settingsGetPublicRoute
  | typeof settingsUpdatePublicRoute

export type CliCommandOperation = 'rpc' | 'stream' | 'upload' | 'download'

export type ParsedCliArguments = Readonly<{
  domain: string
  verb: string
  contract: CliRpcContract | null
  outputMode: CliOutputMode
  timeoutMs: number
  helpRequested: boolean
  operation: CliCommandOperation
  params: JsonValue
  inputPath?: string
  uploadMaxBytes?: number
  outputPath?: string
  overwrite: boolean
  readStdin: boolean
}>

const COMMANDS = new Map<string, CliRpcContract>([
  ['system status', cliStatusRoute],
  ['system version', cliVersionRoute],
  ['system capabilities', cliCapabilitiesRoute],
  ['system doctor', cliDoctorRoute],
  ['artifact describe', artifactsDescribeRoute],
  ['artifact get', artifactsReadRoute],
  ['artifact delete', artifactsDeleteRoute],
  ['model invoke', modelsInvokeRoute],
  ['image generate', imagesGenerateRoute],
  ['video generate', videosGenerateRoute],
  ['audio speak', speechGenerateRoute],
  ['audio transcribe', audioTranscribeUploadRoute],
  ['ocr status', ocrGetRuntimeStatusRoute],
  ['ocr extract', ocrExtractUploadRoute],
  ['ocr clear-cache', ocrClearCacheRoute],
  ['provider list', providersListPublicRoute],
  ['settings get', settingsGetPublicRoute],
  ['settings set', settingsUpdatePublicRoute]
])

function parseBoolean(value: string, source: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new CliUsageError(`${source} must be true or false`)
}

function parseNumberInRange(
  value: string,
  source: string,
  minimum: number,
  maximum: number,
  integer = false
): number {
  const parsed = Number(value)
  if (
    !Number.isFinite(parsed) ||
    (integer && !Number.isSafeInteger(parsed)) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    const qualifier = integer ? 'an integer' : 'a number'
    throw new CliUsageError(`${source} must be ${qualifier} between ${minimum} and ${maximum}`)
  }
  return parsed
}

type DomainOptionValue = JsonValue
type DomainValueParser = (value: string) => DomainOptionValue

const stringOption: DomainValueParser = (value) => value
const settingValueOption: DomainValueParser = (value) => {
  const candidate =
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value) ||
    value.startsWith('"')
      ? (() => {
          try {
            return JSON.parse(value) as unknown
          } catch {
            throw new CliUsageError('--value contains invalid JSON')
          }
        })()
      : value
  const parsed = JsonValueSchema.safeParse(candidate)
  if (!parsed.success) throw new CliUsageError('--value must be a JSON scalar')
  if (parsed.data !== null && typeof parsed.data === 'object') {
    throw new CliUsageError('--value must be a JSON scalar')
  }
  return parsed.data
}
const VALUE_DOMAIN_OPTIONS: Readonly<Record<string, DomainValueParser>> = {
  id: (value) => {
    const parsed = ArtifactIdSchema.safeParse(value)
    if (!parsed.success) throw new CliUsageError('--id is not a valid artifact identifier')
    return parsed.data
  },
  out: stringOption,
  file: stringOption,
  artifact: (value) => {
    const parsed = ArtifactIdSchema.safeParse(value)
    if (!parsed.success) throw new CliUsageError('--artifact is not a valid artifact identifier')
    return parsed.data
  },
  mime: (value) => {
    const normalized = value.trim().toLowerCase()
    if (!normalized) throw new CliUsageError('--mime must not be empty')
    return normalized
  },
  provider: stringOption,
  model: stringOption,
  prompt: stringOption,
  text: stringOption,
  system: stringOption,
  temperature: (value) => parseNumberInRange(value, '--temperature', 0, 2),
  'max-tokens': (value) => parseNumberInRange(value, '--max-tokens', 1, 1_000_000, true),
  size: stringOption,
  quality: stringOption,
  format: stringOption,
  compression: (value) => parseNumberInRange(value, '--compression', 0, 100, true),
  background: stringOption,
  moderation: stringOption,
  seconds: stringOption,
  ratio: stringOption,
  duration: (value) => parseNumberInRange(value, '--duration', -1, 3_600, true),
  resolution: stringOption,
  watermark: (value) => parseBoolean(value, '--watermark'),
  audio: (value) => parseBoolean(value, '--audio'),
  voice: stringOption,
  speed: (value) => parseNumberInRange(value, '--speed', 0.25, 4),
  instructions: stringOption,
  key: stringOption,
  keys: stringOption,
  value: settingValueOption,
  backend: stringOption,
  'page-count': (value) =>
    parseNumberInRange(value, '--page-count', 1, PDF_PAGE_COUNT_SANITY_LIMIT, true)
}

const FLAG_DOMAIN_OPTIONS = new Set(['overwrite', 'stdin', 'enabled-only'])
const COMMAND_DOMAIN_OPTIONS = new Map<string, ReadonlySet<string>>([
  ['artifact describe', new Set(['id'])],
  ['artifact get', new Set(['id', 'out', 'overwrite'])],
  ['artifact delete', new Set(['id'])],
  [
    'model invoke',
    new Set(['provider', 'model', 'prompt', 'system', 'temperature', 'max-tokens', 'stdin'])
  ],
  [
    'image generate',
    new Set([
      'provider',
      'model',
      'prompt',
      'stdin',
      'size',
      'quality',
      'format',
      'compression',
      'background',
      'moderation'
    ])
  ],
  [
    'video generate',
    new Set([
      'provider',
      'model',
      'prompt',
      'stdin',
      'seconds',
      'size',
      'ratio',
      'duration',
      'resolution',
      'watermark',
      'audio'
    ])
  ],
  [
    'audio speak',
    new Set(['provider', 'model', 'text', 'stdin', 'voice', 'format', 'speed', 'instructions'])
  ],
  ['audio transcribe', new Set(['provider', 'model', 'file', 'artifact', 'mime'])],
  ['ocr extract', new Set(['file', 'artifact', 'mime', 'backend', 'page-count', 'max-tokens'])],
  ['ocr status', new Set()],
  ['ocr clear-cache', new Set()],
  ['provider list', new Set(['enabled-only'])],
  ['settings get', new Set(['keys'])],
  ['settings set', new Set(['key', 'value'])]
])

const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm'
}

const OCR_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp'
}

function resolveInputMimeType(
  filePath: string,
  explicitMimeType: string | undefined,
  mimeTypesByExtension: Readonly<Record<string, string>>
): string {
  if (explicitMimeType) return explicitMimeType
  const inferred = mimeTypesByExtension[path.extname(filePath).toLowerCase()]
  if (!inferred) {
    throw new CliUsageError('Cannot infer input MIME type; provide --mime <type>')
  }
  return inferred
}

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
  let contract = COMMANDS.get(commandKey) ?? null
  if (!contract && !isHelpCommand) {
    throw new CliUsageError(`Unknown command: deepchat ${domain} ${verb}`)
  }

  let outputMode = parseOutputMode(env[CLI_OUTPUT_ENV])
  let explicitOutputMode: CliOutputMode | undefined
  let timeoutMs = env[CLI_TIMEOUT_ENV]
    ? parseTimeout(env[CLI_TIMEOUT_ENV], CLI_TIMEOUT_ENV)
    : commandKey === 'model invoke' ||
        commandKey === 'image generate' ||
        commandKey === 'video generate' ||
        commandKey === 'audio speak' ||
        commandKey === 'audio transcribe' ||
        commandKey === 'ocr extract' ||
        commandKey === 'ocr clear-cache'
      ? DEFAULT_COMPUTE_TIMEOUT_MS
      : DEFAULT_CLI_TIMEOUT_MS
  let timeoutSeen = false
  let helpRequested = false
  const domainOptions = new Set<string>()
  const domainValues = new Map<string, DomainOptionValue>()

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
    if (argument.startsWith('--')) {
      const equalsIndex = argument.indexOf('=')
      const optionName = argument.slice(2, equalsIndex >= 0 ? equalsIndex : undefined)
      if (FLAG_DOMAIN_OPTIONS.has(optionName) && equalsIndex < 0) {
        if (domainOptions.has(optionName)) {
          throw new CliUsageError(`--${optionName} may be specified only once`)
        }
        domainOptions.add(optionName)
        domainValues.set(optionName, true)
        continue
      }
      const parseValue = VALUE_DOMAIN_OPTIONS[optionName]
      if (parseValue) {
        if (domainOptions.has(optionName)) {
          throw new CliUsageError(`--${optionName} may be specified only once`)
        }
        const parsedOption = readOptionValue(argument, index)
        domainOptions.add(optionName)
        domainValues.set(optionName, parseValue(parsedOption.value))
        index = parsedOption.nextIndex
        continue
      }
    }
    throw new CliUsageError(`Unknown option after ${domain} ${verb}: ${argument}`)
  }

  const getString = (name: string): string | undefined => {
    const value = domainValues.get(name)
    return typeof value === 'string' ? value : undefined
  }
  const getNumber = (name: string): number | undefined => {
    const value = domainValues.get(name)
    return typeof value === 'number' ? value : undefined
  }
  const getBoolean = (name: string): boolean | undefined => {
    const value = domainValues.get(name)
    return typeof value === 'boolean' ? value : undefined
  }
  const artifactId = getString('id')
  const inputArtifactId = getString('artifact')
  const inputPath = getString('file')
  const mimeType = getString('mime')
  const outputPath = getString('out')
  const overwrite = getBoolean('overwrite') ?? false
  const providerId = getString('provider')
  const modelId = getString('model')
  const prompt = getString('prompt')
  const textInput = getString('text')
  const systemPrompt = getString('system')
  const temperature = getNumber('temperature')
  const maxTokens = getNumber('max-tokens')
  const readStdin = getBoolean('stdin') ?? false
  const enabledOnly = getBoolean('enabled-only') ?? false
  const size = getString('size')
  const quality = getString('quality')
  const format = getString('format')
  const compression = getNumber('compression')
  const background = getString('background')
  const moderation = getString('moderation')
  const seconds = getString('seconds')
  const ratio = getString('ratio')
  const duration = getNumber('duration')
  const resolution = getString('resolution')
  const watermark = getBoolean('watermark')
  const generateAudio = getBoolean('audio')
  const voice = getString('voice')
  const speed = getNumber('speed')
  const instructions = getString('instructions')
  const backend = getString('backend')
  const sourcePageCountHint = getNumber('page-count')
  const settingKey = getString('key')
  const settingKeys = getString('keys')
  const settingValue = domainValues.get('value')
  const parsedSettingKeys = settingKeys
    ?.split(',')
    .map((key) => key.trim())
    .filter(Boolean)

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

  const isModelInvoke = commandKey === 'model invoke'
  const isImageGenerate = commandKey === 'image generate'
  const isVideoGenerate = commandKey === 'video generate'
  const isSpeechGenerate = commandKey === 'audio speak'
  const isAudioTranscribe = commandKey === 'audio transcribe'
  const isOcrExtract = commandKey === 'ocr extract'
  const isMediaGenerate = isImageGenerate || isVideoGenerate || isSpeechGenerate
  const isProviderList = commandKey === 'provider list'
  const isSettingsGet = commandKey === 'settings get'
  const isSettingsSet = commandKey === 'settings set'
  const allowedDomainOptions = COMMAND_DOMAIN_OPTIONS.get(commandKey) ?? new Set<string>()
  const invalidDomainOption = Array.from(domainOptions).find(
    (option) => !allowedDomainOptions.has(option)
  )
  if (invalidDomainOption) {
    throw new CliUsageError(`--${invalidDomainOption} is not valid for deepchat ${domain} ${verb}`)
  }
  if (!helpRequested && isModelInvoke && (!providerId || !modelId)) {
    throw new CliUsageError('deepchat model invoke requires --provider and --model')
  }
  if (!helpRequested && isModelInvoke && (prompt !== undefined) === readStdin) {
    throw new CliUsageError('deepchat model invoke requires exactly one of --prompt or --stdin')
  }
  if (!helpRequested && isMediaGenerate && (!providerId || !modelId)) {
    throw new CliUsageError(`deepchat ${domain} ${verb} requires --provider and --model`)
  }
  if (
    !helpRequested &&
    (isImageGenerate || isVideoGenerate) &&
    (prompt !== undefined) === readStdin
  ) {
    throw new CliUsageError(
      `deepchat ${domain} ${verb} requires exactly one of --prompt or --stdin`
    )
  }
  if (!helpRequested && isSpeechGenerate && (textInput !== undefined) === readStdin) {
    throw new CliUsageError('deepchat audio speak requires exactly one of --text or --stdin')
  }
  if (!helpRequested && isAudioTranscribe && (!providerId || !modelId)) {
    throw new CliUsageError('deepchat audio transcribe requires --provider and --model')
  }
  if (
    !helpRequested &&
    (isAudioTranscribe || isOcrExtract) &&
    (inputPath !== undefined) === (inputArtifactId !== undefined)
  ) {
    throw new CliUsageError(
      `deepchat ${domain} ${verb} requires exactly one of --file or --artifact`
    )
  }
  if (!helpRequested && inputArtifactId && mimeType) {
    throw new CliUsageError('--mime is only valid together with --file')
  }
  if (backend !== undefined && backend !== 'auto' && backend !== 'cpu') {
    throw new CliUsageError('--backend must be auto or cpu')
  }
  if (isOcrExtract && maxTokens !== undefined && maxTokens > ATTACHMENT_PDF_OCR_MAX_TOKENS) {
    throw new CliUsageError(`--max-tokens must not exceed ${ATTACHMENT_PDF_OCR_MAX_TOKENS}`)
  }
  if (!helpRequested && isSettingsSet && (!settingKey || !domainOptions.has('value'))) {
    throw new CliUsageError('deepchat settings set requires --key and --value')
  }
  if (!helpRequested && isSettingsGet && settingKeys !== undefined && !parsedSettingKeys?.length) {
    throw new CliUsageError('--keys must contain at least one setting key')
  }

  let params: JsonValue = artifactId ? { id: artifactId } : {}
  if (isProviderList) params = { enabledOnly }
  if (isSettingsGet) {
    params = parsedSettingKeys ? { keys: parsedSettingKeys } : {}
  }
  if (isSettingsSet && settingKey && domainOptions.has('value')) {
    params = { changes: [{ key: settingKey, value: settingValue ?? null }] }
  }
  if (isModelInvoke && providerId && modelId) {
    params = {
      providerId,
      modelId,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...(prompt !== undefined ? [{ role: 'user', content: prompt }] : [])
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {})
    }
  }
  if (isImageGenerate && providerId && modelId) {
    const options = {
      ...(size !== undefined ? { size } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(format !== undefined ? { outputFormat: format } : {}),
      ...(compression !== undefined ? { outputCompression: compression } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(moderation !== undefined ? { moderation } : {})
    }
    params = {
      providerId,
      modelId,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {})
    }
  }
  if (isVideoGenerate && providerId && modelId) {
    const options = {
      ...(seconds !== undefined ? { seconds } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(ratio !== undefined ? { ratio } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(watermark !== undefined ? { watermark } : {}),
      ...(generateAudio !== undefined ? { generateAudio } : {})
    }
    params = {
      providerId,
      modelId,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {})
    }
  }
  if (isSpeechGenerate && providerId && modelId) {
    const options = {
      ...(voice !== undefined ? { voice } : {}),
      ...(format !== undefined ? { responseFormat: format } : {}),
      ...(speed !== undefined ? { speed } : {}),
      ...(instructions !== undefined ? { instructions } : {})
    }
    params = {
      providerId,
      modelId,
      ...(textInput !== undefined ? { text: textInput } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {})
    }
  }
  if (isAudioTranscribe && providerId && modelId && (inputPath || inputArtifactId)) {
    if (inputPath) {
      contract = audioTranscribeUploadRoute
      params = {
        providerId,
        modelId,
        mimeType: resolveInputMimeType(inputPath, mimeType, AUDIO_MIME_BY_EXTENSION),
        filename: path.basename(inputPath)
      }
    } else if (inputArtifactId) {
      contract = audioTranscribeArtifactRoute
      params = { providerId, modelId, artifactId: inputArtifactId }
    }
  }
  if (isOcrExtract && (inputPath || inputArtifactId)) {
    const options = {
      ...(backend !== undefined ? { backend } : {}),
      ...(sourcePageCountHint !== undefined ? { sourcePageCountHint } : {}),
      ...(maxTokens !== undefined ? { generationTokenLimit: maxTokens } : {})
    }
    if (inputPath) {
      const resolvedMimeType = resolveInputMimeType(inputPath, mimeType, OCR_MIME_BY_EXTENSION)
      if (
        resolvedMimeType !== 'application/pdf' &&
        (sourcePageCountHint !== undefined || maxTokens !== undefined)
      ) {
        throw new CliUsageError('--page-count and --max-tokens are only valid for PDF input')
      }
      contract = ocrExtractUploadRoute
      params = {
        ...options,
        mimeType: resolvedMimeType
      }
    } else if (inputArtifactId) {
      contract = ocrExtractArtifactRoute
      params = { ...options, artifactId: inputArtifactId }
    }
  }

  return {
    domain,
    verb,
    contract,
    outputMode,
    timeoutMs,
    helpRequested: helpRequested || isHelpCommand,
    operation:
      commandKey === 'artifact get'
        ? 'download'
        : inputPath && (isAudioTranscribe || isOcrExtract)
          ? 'upload'
          : isModelInvoke || isMediaGenerate
            ? 'stream'
            : 'rpc',
    params,
    ...(inputPath ? { inputPath } : {}),
    ...(isAudioTranscribe && inputPath
      ? { uploadMaxBytes: AUDIO_TRANSCRIPTION_MAX_INPUT_BYTES }
      : {}),
    ...(isOcrExtract && inputPath ? { uploadMaxBytes: OCR_EXTRACTION_MAX_INPUT_BYTES } : {}),
    ...(outputPath ? { outputPath } : {}),
    overwrite,
    readStdin
  }
}

export function formatCliHelp(command?: Pick<ParsedCliArguments, 'domain' | 'verb'>): string {
  if (command && command.domain !== 'help') {
    const commandOptions =
      command.domain === 'artifact'
        ? command.verb === 'get'
          ? ' --id <artifact-id> --out <path> [--overwrite]'
          : ' --id <artifact-id>'
        : command.domain === 'model'
          ? ' --provider <id> --model <id> (--prompt <text>|--stdin)'
          : command.domain === 'image' || command.domain === 'video'
            ? ' --provider <id> --model <id> (--prompt <text>|--stdin)'
            : command.domain === 'audio' && command.verb === 'speak'
              ? ' --provider <id> --model <id> (--text <text>|--stdin)'
              : command.domain === 'audio'
                ? ' --provider <id> --model <id> (--file <path>|--artifact <id>)'
                : command.domain === 'ocr' && command.verb === 'extract'
                  ? ' (--file <path>|--artifact <id>)'
                  : command.domain === 'provider'
                    ? ' [--enabled-only]'
                    : command.domain === 'settings' && command.verb === 'get'
                      ? ' [--keys <key,key>]'
                      : command.domain === 'settings'
                        ? ' --key <key> --value <json-scalar>'
                        : ''
    const commandKey = `${command.domain} ${command.verb}`
    const optionLines =
      commandKey === 'model invoke'
        ? [
            '  --system <text>       Add a system message',
            '  --temperature <n>     Set sampling temperature (0..2)',
            '  --max-tokens <n>      Set the output-token limit'
          ]
        : commandKey === 'image generate'
          ? [
              '  --size <value>       Set output dimensions',
              '  --quality <value>    Set low, medium, high, or auto quality',
              '  --format <value>     Set png, jpeg, or webp output',
              '  --compression <n>    Set jpeg/webp compression (0..100)',
              '  --background <value> Set auto or opaque background',
              '  --moderation <value> Set auto or low moderation'
            ]
          : commandKey === 'video generate'
            ? [
                '  --seconds <value>    Set provider-specific clip seconds',
                '  --size <value>       Set provider-specific dimensions',
                '  --ratio <value>      Set aspect ratio',
                '  --duration <n>       Set duration (-1..3600)',
                '  --resolution <value> Set output resolution',
                '  --watermark <bool>   Enable or disable watermarking',
                '  --audio <bool>       Enable or disable generated audio'
              ]
            : commandKey === 'audio speak'
              ? [
                  '  --voice <value>      Select a voice',
                  '  --format <value>     Set mp3, opus, aac, flac, wav, or pcm',
                  '  --speed <n>          Set playback speed (0.25..4)',
                  '  --instructions <text> Add provider-supported speech guidance'
                ]
              : commandKey === 'audio transcribe'
                ? ['  --mime <type>        Override the MIME type inferred from --file']
                : commandKey === 'ocr extract'
                  ? [
                      '  --mime <type>        Override the MIME type inferred from --file',
                      '  --backend <value>    Select auto or cpu',
                      '  --page-count <n>     Provide a PDF page-count hint',
                      '  --max-tokens <n>     Limit PDF OCR output tokens'
                    ]
                  : []
    return [
      `Usage: deepchat ${command.domain} ${command.verb}${commandOptions} [--json|--jsonl] [--timeout <ms>]`,
      '',
      'Global flags must follow the domain and verb.',
      ...(optionLines.length > 0 ? ['', 'Command options:', ...optionLines] : [])
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
    '  model invoke         Stream a raw text-model invocation',
    '  image generate       Generate image artifacts',
    '  video generate       Generate video artifacts',
    '  audio speak          Generate a speech artifact',
    '  audio transcribe     Transcribe an audio file or owned artifact',
    '  ocr status           Show offline OCR runtime and cache status',
    '  ocr extract          Extract text from an image or PDF',
    '  ocr clear-cache      Clear derived OCR cache entries',
    '  provider list        List redacted providers and models',
    '  settings get         Read allowlisted public settings',
    '  settings set         Update one allowlisted public setting',
    '  help commands        Show this help',
    '',
    'Options (after domain and verb):',
    '  --json               Emit one JSON result envelope',
    '  --jsonl              Emit JSONL records',
    '  --timeout <ms>       Set request timeout',
    '  --help               Show command usage and options',
    '',
    'Run deepchat <domain> <verb> --help for command-specific options.'
  ].join('\n')
}
