import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import type { CliLauncherStatus } from '@shared/contracts/routes'

export type {
  CliLauncherReason,
  CliLauncherState,
  CliLauncherStatus
} from '@shared/contracts/routes'

const LAUNCHER_MARKER_VERSION = 1
const LAUNCHER_MARKER_FILENAME = 'launcher.json'
const MANAGED_BLOCK_START = '# >>> DeepChat CLI >>>'
const MANAGED_BLOCK_END = '# <<< DeepChat CLI <<<'
const MAX_MARKER_BYTES = 16 * 1024
const MAX_SHELL_CONFIG_BYTES = 1024 * 1024

type PosixProfileKind = 'zsh' | 'bash' | 'bash-login' | 'fish' | 'profile'

type PosixLauncherMarker = Readonly<{
  version: 1
  platform: 'posix'
  commandPath: string
  launcherTarget: string
  profileKind: PosixProfileKind | null
  profilePrefixLength: 0 | 1 | 2
  profileCreated: boolean
}>

type WindowsLauncherMarker = Readonly<{
  version: 1
  platform: 'windows'
  commandPath: string
  commandHash: string
}>

type LauncherMarker = PosixLauncherMarker | WindowsLauncherMarker

export type CliLauncherServiceOptions = Readonly<{
  platform?: NodeJS.Platform
  homeDirectory: string
  userDataDirectory: string
  environmentPath?: string
  shell?: string
  localAppDataDirectory?: string
  resolveCliDirectory(): string | null
}>

type MarkerReadResult =
  | Readonly<{ state: 'missing'; raw: null }>
  | Readonly<{ state: 'invalid'; raw: string }>
  | Readonly<{ state: 'valid'; raw: string; marker: LauncherMarker }>

type ProfileInspection = Readonly<{
  kind: PosixProfileKind
  path: string
  content: string
  exists: boolean
  blockState: 'missing' | 'exact' | 'modified'
}>

type AppendedManagedBlock = Readonly<{
  content: string
  prefixLength: 0 | 1 | 2
}>

type CliSource = Readonly<{
  directory: string
  posixLauncher: string
  modulePath: string
}>

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isPosixProfileKind(value: unknown): value is PosixProfileKind {
  return (
    value === 'zsh' ||
    value === 'bash' ||
    value === 'bash-login' ||
    value === 'fish' ||
    value === 'profile'
  )
}

function parseLauncherMarker(value: unknown): LauncherMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const marker = value as Record<string, unknown>
  if (marker.version !== LAUNCHER_MARKER_VERSION || typeof marker.commandPath !== 'string') {
    return null
  }
  if (
    marker.platform === 'posix' &&
    typeof marker.launcherTarget === 'string' &&
    (marker.profileKind === null || isPosixProfileKind(marker.profileKind)) &&
    (marker.profilePrefixLength === 0 ||
      marker.profilePrefixLength === 1 ||
      marker.profilePrefixLength === 2) &&
    typeof marker.profileCreated === 'boolean'
  ) {
    return marker as PosixLauncherMarker
  }
  if (
    marker.platform === 'windows' &&
    typeof marker.commandHash === 'string' &&
    /^[0-9a-f]{64}$/.test(marker.commandHash)
  ) {
    return marker as WindowsLauncherMarker
  }
  return null
}

function managedProfileBlock(kind: PosixProfileKind): string {
  const command =
    kind === 'fish'
      ? 'fish_add_path --global --move "$HOME/.local/bin"'
      : 'case ":$PATH:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin:$PATH" ;;\nesac'
  return `${MANAGED_BLOCK_START}\n${command}\n${MANAGED_BLOCK_END}`
}

function inspectManagedBlock(content: string, block: string): ProfileInspection['blockState'] {
  const blockOccurrences = content.split(block).length - 1
  const startOccurrences = content.split(MANAGED_BLOCK_START).length - 1
  const endOccurrences = content.split(MANAGED_BLOCK_END).length - 1
  if (blockOccurrences === 1 && startOccurrences === 1 && endOccurrences === 1) return 'exact'
  if (startOccurrences === 0 && endOccurrences === 0) return 'missing'
  return 'modified'
}

function appendManagedBlock(content: string, block: string): AppendedManagedBlock {
  const prefixLength: AppendedManagedBlock['prefixLength'] = content
    ? content.endsWith('\n')
      ? 1
      : 2
    : 0
  return {
    content: `${content}${'\n'.repeat(prefixLength)}${block}\n`,
    prefixLength
  }
}

function hasManagedBlockPrefix(content: string, block: string, prefixLength: 0 | 1 | 2): boolean {
  const index = content.indexOf(block)
  return (
    index >= prefixLength &&
    content.slice(index - prefixLength, index) === '\n'.repeat(prefixLength)
  )
}

function removeManagedBlock(content: string, block: string, prefixLength: 0 | 1 | 2): string {
  const index = content.indexOf(block)
  if (index < 0) return content
  const start = index - prefixLength
  let end = index + block.length
  if (content[end] === '\n') end += 1
  return `${content.slice(0, start)}${content.slice(end)}`
}

function escapeBatchLiteral(value: string): string {
  return value.replaceAll('%', '%%')
}

function createWindowsCommand(source: CliSource): string {
  const cliModule = escapeBatchLiteral(source.modulePath)
  const runtimeCandidates = [
    path.join(source.directory, '..', 'runtime', 'node', 'node.exe'),
    path.join(source.directory, '..', '..', 'runtime', 'node', 'node.exe')
  ].map((candidate) => escapeBatchLiteral(path.resolve(candidate)))
  return [
    '@echo off',
    'setlocal',
    `set "cli_module=${cliModule}"`,
    `set "runtime_node=${runtimeCandidates[0]}"`,
    `if not exist "%runtime_node%" set "runtime_node=${runtimeCandidates[1]}"`,
    'if exist "%runtime_node%" goto bundled_runtime',
    'where node >nul 2>&1',
    'if errorlevel 1 goto missing_runtime',
    'node "%cli_module%" %*',
    'exit /b %errorlevel%',
    ':bundled_runtime',
    '"%runtime_node%" "%cli_module%" %*',
    'exit /b %errorlevel%',
    ':missing_runtime',
    'echo DeepChat CLI requires the bundled Node.js runtime or node on PATH. 1>&2',
    'exit /b 127',
    ''
  ].join('\r\n')
}

export class CliLauncherService {
  private readonly platform: NodeJS.Platform
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: CliLauncherServiceOptions) {
    this.platform = options.platform ?? process.platform
  }

  async getStatus(): Promise<CliLauncherStatus> {
    return await this.runExclusive(() => this.inspectStatus())
  }

  async setInstalled(installed: boolean): Promise<CliLauncherStatus> {
    return await this.runExclusive(async () => {
      if (installed) await this.installOrRepair()
      else await this.uninstall()
      return await this.inspectStatus()
    })
  }

  async reconcileOwnedLauncher(): Promise<void> {
    await this.runExclusive(async () => {
      const status = await this.inspectStatus()
      if (status.state !== 'stale') return
      await this.installOrRepair()
    })
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation)
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return await run
  }

  private get markerPath(): string {
    return path.join(this.options.userDataDirectory, 'local-control', LAUNCHER_MARKER_FILENAME)
  }

  private get isSupportedPlatform(): boolean {
    return this.platform === 'darwin' || this.platform === 'linux' || this.platform === 'win32'
  }

  private get commandPath(): string | null {
    if (this.platform === 'darwin' || this.platform === 'linux') {
      return path.join(this.options.homeDirectory, '.local', 'bin', 'deepchat')
    }
    if (this.platform === 'win32') {
      const localAppData =
        this.options.localAppDataDirectory ??
        path.join(this.options.homeDirectory, 'AppData', 'Local')
      return path.join(localAppData, 'Microsoft', 'WindowsApps', 'deepchat.cmd')
    }
    return null
  }

  private async resolveSource(): Promise<CliSource | null> {
    const directory = this.options.resolveCliDirectory()
    if (!directory) return null
    const resolvedDirectory = path.resolve(directory)
    const source = {
      directory: resolvedDirectory,
      posixLauncher: path.join(resolvedDirectory, 'deepchat'),
      modulePath: path.join(resolvedDirectory, 'deepchat.mjs')
    }
    const requiredPaths =
      this.platform === 'win32' ? [source.modulePath] : [source.posixLauncher, source.modulePath]
    for (const requiredPath of requiredPaths) {
      try {
        const stats = await lstat(requiredPath)
        if (!stats.isFile() || stats.isSymbolicLink()) return null
        if (
          this.platform !== 'win32' &&
          requiredPath === source.posixLauncher &&
          (stats.mode & 0o111) === 0
        ) {
          return null
        }
      } catch (error) {
        if (isMissingFileError(error)) return null
        throw error
      }
    }
    return source
  }

  private async inspectStatus(): Promise<CliLauncherStatus> {
    const commandPath = this.commandPath
    if (!this.isSupportedPlatform || !commandPath) {
      return {
        state: 'unavailable',
        reason: 'unsupported-platform',
        commandPath: null,
        shellConfigPath: null
      }
    }

    const markerResult = await this.readMarker()
    if (markerResult.state === 'invalid') {
      return {
        state: 'conflict',
        reason: 'ownership-marker-invalid',
        commandPath,
        shellConfigPath: null
      }
    }

    if (markerResult.state === 'missing') {
      if ((await this.pathEntryExists(commandPath)) || (await this.hasOrphanedManagedBlock())) {
        return {
          state: 'conflict',
          reason: 'unowned-command',
          commandPath,
          shellConfigPath: null
        }
      }
      if (this.platform === 'win32' && !this.isCommandDirectoryOnPath()) {
        return {
          state: 'unavailable',
          reason: 'path-unavailable',
          commandPath,
          shellConfigPath: null
        }
      }
      const source = await this.resolveSource()
      return {
        state: source ? 'not-installed' : 'unavailable',
        reason: source ? null : 'source-missing',
        commandPath,
        shellConfigPath: null
      }
    }

    const { marker } = markerResult
    const expectedPlatform = this.platform === 'win32' ? 'windows' : 'posix'
    if (marker.platform !== expectedPlatform || path.resolve(marker.commandPath) !== commandPath) {
      return {
        state: 'conflict',
        reason: 'ownership-marker-invalid',
        commandPath,
        shellConfigPath: null
      }
    }

    const profile =
      marker.platform === 'posix' ? await this.inspectProfile(marker.profileKind) : null
    if (
      profile?.blockState === 'modified' ||
      (profile?.blockState === 'exact' &&
        marker.platform === 'posix' &&
        !hasManagedBlockPrefix(
          profile.content,
          managedProfileBlock(profile.kind),
          marker.profilePrefixLength
        ))
    ) {
      return {
        state: 'conflict',
        reason: 'shell-config-modified',
        commandPath,
        shellConfigPath: profile.path
      }
    }

    const commandState = await this.inspectOwnedCommand(marker)
    if (commandState === 'modified') {
      return {
        state: 'conflict',
        reason: 'command-modified',
        commandPath,
        shellConfigPath: profile?.path ?? null
      }
    }
    if (commandState === 'missing') {
      return {
        state: 'needs-repair',
        reason: 'command-missing',
        commandPath,
        shellConfigPath: profile?.path ?? null
      }
    }
    if (profile?.blockState === 'missing') {
      return {
        state: 'needs-repair',
        reason: 'shell-config-missing',
        commandPath,
        shellConfigPath: profile.path
      }
    }
    if (this.platform === 'win32' && !this.isCommandDirectoryOnPath()) {
      return {
        state: 'needs-repair',
        reason: 'path-unavailable',
        commandPath,
        shellConfigPath: null
      }
    }

    const source = await this.resolveSource()
    if (!source) {
      return {
        state: 'unavailable',
        reason: 'source-missing',
        commandPath,
        shellConfigPath: profile?.path ?? null
      }
    }
    const current = this.markerForSource(
      source,
      marker.platform === 'posix' ? marker.profileKind : null,
      marker.platform === 'posix' ? marker.profilePrefixLength : 0,
      marker.platform === 'posix' ? marker.profileCreated : false
    )
    const stale =
      marker.platform === 'posix'
        ? marker.launcherTarget !== (current as PosixLauncherMarker).launcherTarget
        : marker.commandHash !== (current as WindowsLauncherMarker).commandHash
    return {
      state: stale ? 'stale' : 'installed',
      reason: stale ? 'upgrade-required' : null,
      commandPath,
      shellConfigPath: profile?.path ?? null
    }
  }

  private async installOrRepair(): Promise<void> {
    if (!this.isSupportedPlatform || !this.commandPath) {
      throw new Error('DeepChat CLI launcher installation is not supported on this platform')
    }
    const source = await this.resolveSource()
    if (!source) throw new Error('The bundled DeepChat CLI is unavailable')
    if (this.platform === 'win32' && !this.isCommandDirectoryOnPath()) {
      throw new Error('The Windows user command directory is not available on PATH')
    }
    const markerResult = await this.readMarker()
    if (markerResult.state === 'invalid') {
      throw new Error('The DeepChat CLI ownership marker is invalid')
    }

    let previousMarker: LauncherMarker | null = null
    let previousMarkerRaw: string | null = null
    let profileKind: PosixProfileKind | null = null
    if (markerResult.state === 'valid') {
      previousMarker = markerResult.marker
      previousMarkerRaw = markerResult.raw
      const expectedPlatform = this.platform === 'win32' ? 'windows' : 'posix'
      if (
        previousMarker.platform !== expectedPlatform ||
        path.resolve(previousMarker.commandPath) !== this.commandPath
      ) {
        throw new Error('The DeepChat CLI ownership marker does not match this installation')
      }
      profileKind = previousMarker.platform === 'posix' ? previousMarker.profileKind : null
    } else {
      if (
        (await this.pathEntryExists(this.commandPath)) ||
        (await this.hasOrphanedManagedBlock())
      ) {
        throw new Error('A DeepChat CLI command or shell block exists without an ownership marker')
      }
      profileKind = this.platform === 'win32' ? null : await this.selectProfileKind()
    }

    const profile = this.platform === 'win32' ? null : await this.inspectProfile(profileKind)
    if (profile?.blockState === 'modified') {
      throw new Error('The managed DeepChat CLI shell block has been modified')
    }

    const previousCommand = await this.captureOwnedCommand(previousMarker)
    const previousProfileContent = profile?.exists ? profile.content : null
    const appendedProfile =
      profile && profile.blockState === 'missing'
        ? appendManagedBlock(profile.content, managedProfileBlock(profile.kind))
        : null
    const profilePrefixLength =
      appendedProfile?.prefixLength ??
      (previousMarker?.platform === 'posix' ? previousMarker.profilePrefixLength : 0)
    const profileCreated =
      previousMarker?.platform === 'posix'
        ? previousMarker.profileCreated
        : Boolean(profile && !profile.exists)
    if (
      profile?.blockState === 'exact' &&
      previousMarker?.platform === 'posix' &&
      !hasManagedBlockPrefix(
        profile.content,
        managedProfileBlock(profile.kind),
        previousMarker.profilePrefixLength
      )
    ) {
      throw new Error('The managed DeepChat CLI shell block prefix has been modified')
    }
    const nextProfileContent = appendedProfile?.content ?? previousProfileContent
    const nextMarker = this.markerForSource(
      source,
      profileKind,
      profilePrefixLength,
      profileCreated
    )
    const nextMarkerRaw = `${JSON.stringify(nextMarker)}\n`
    const nextCommand = this.commandForSource(source)
    let commandChanged = false
    let profileChanged = false
    try {
      if (previousCommand !== nextCommand) {
        await this.writeOwnedCommand(source, previousCommand)
        commandChanged = true
      }
      if (profile && nextProfileContent !== null && nextProfileContent !== previousProfileContent) {
        await this.prepareHomeManagedDirectory(path.dirname(profile.path))
        await this.atomicWriteText(profile.path, nextProfileContent, previousProfileContent, 0o644)
        profileChanged = true
      }
      if (nextMarkerRaw !== previousMarkerRaw) {
        await this.writeMarker(nextMarkerRaw, previousMarkerRaw)
      }
    } catch (error) {
      if (profileChanged && profile && nextProfileContent !== null) {
        await this.restoreTextFile(profile.path, previousProfileContent, nextProfileContent).catch(
          () => undefined
        )
      }
      if (commandChanged) {
        await this.restoreOwnedCommand(previousCommand, nextCommand).catch(() => undefined)
      }
      throw error
    }
  }

  private async uninstall(): Promise<void> {
    const commandPath = this.commandPath
    if (!this.isSupportedPlatform || !commandPath) {
      throw new Error('DeepChat CLI launcher removal is not supported on this platform')
    }
    const markerResult = await this.readMarker()
    if (markerResult.state === 'invalid') {
      throw new Error('The DeepChat CLI ownership marker is invalid')
    }
    if (markerResult.state === 'missing') {
      if ((await this.pathEntryExists(commandPath)) || (await this.hasOrphanedManagedBlock())) {
        throw new Error('Refusing to remove a CLI command without an ownership marker')
      }
      return
    }

    const { marker, raw: markerRaw } = markerResult
    const expectedPlatform = this.platform === 'win32' ? 'windows' : 'posix'
    if (marker.platform !== expectedPlatform || path.resolve(marker.commandPath) !== commandPath) {
      throw new Error('The DeepChat CLI ownership marker does not match this installation')
    }
    const profile =
      marker.platform === 'posix' ? await this.inspectProfile(marker.profileKind) : null
    if (
      profile?.blockState === 'modified' ||
      (profile?.blockState === 'exact' &&
        marker.platform === 'posix' &&
        !hasManagedBlockPrefix(
          profile.content,
          managedProfileBlock(profile.kind),
          marker.profilePrefixLength
        ))
    ) {
      throw new Error('Refusing to edit a modified DeepChat CLI shell block')
    }
    const previousCommand = await this.captureOwnedCommand(marker)
    const previousProfileContent = profile?.exists ? profile.content : null
    const nextProfileContent =
      profile?.blockState === 'exact' && marker.platform === 'posix'
        ? removeManagedBlock(
            profile.content,
            managedProfileBlock(profile.kind),
            marker.profilePrefixLength
          )
        : previousProfileContent
    let commandRemoved = false
    let profileChanged = false
    let profileRemoved = false
    try {
      if (previousCommand !== null) {
        await this.removeOwnedCommand(previousCommand)
        commandRemoved = true
      }
      if (profile && nextProfileContent !== null && nextProfileContent !== previousProfileContent) {
        await this.prepareHomeManagedDirectory(path.dirname(profile.path))
        if (marker.platform === 'posix' && marker.profileCreated && nextProfileContent === '') {
          await this.unlinkTextIfMatches(profile.path, previousProfileContent ?? '')
          profileRemoved = true
        } else {
          await this.atomicWriteText(
            profile.path,
            nextProfileContent,
            previousProfileContent,
            0o644
          )
        }
        profileChanged = true
      }
      await this.removeMarker(markerRaw)
    } catch (error) {
      if (profileChanged && profile && nextProfileContent !== null) {
        await this.restoreTextFile(
          profile.path,
          previousProfileContent,
          profileRemoved ? null : nextProfileContent
        ).catch(() => undefined)
      }
      if (commandRemoved) {
        await this.restoreOwnedCommand(previousCommand, null).catch(() => undefined)
      }
      throw error
    }
  }

  private async selectProfileKind(): Promise<PosixProfileKind | null> {
    if (this.isCommandDirectoryOnPath()) return null
    switch (path.basename(this.options.shell ?? '')) {
      case 'zsh':
        return 'zsh'
      case 'bash':
        if (this.platform === 'darwin') {
          if (await this.pathEntryExists(path.join(this.options.homeDirectory, '.bash_profile'))) {
            return 'bash'
          }
          if (await this.pathEntryExists(path.join(this.options.homeDirectory, '.bash_login'))) {
            return 'bash-login'
          }
          return 'profile'
        }
        return 'bash'
      case 'fish':
        return 'fish'
      default:
        return 'profile'
    }
  }

  private isCommandDirectoryOnPath(): boolean {
    const commandPath = this.commandPath
    if (!commandPath) return false
    const commandDirectory = path.resolve(path.dirname(commandPath))
    const delimiter = this.platform === 'win32' ? ';' : ':'
    return (this.options.environmentPath ?? '').split(delimiter).some((entry) => {
      if (!entry) return false
      const candidate = path.resolve(entry.replace(/^"|"$/g, ''))
      return this.platform === 'win32'
        ? candidate.toLowerCase() === commandDirectory.toLowerCase()
        : candidate === commandDirectory
    })
  }

  private profilePath(kind: PosixProfileKind): string {
    switch (kind) {
      case 'zsh':
        return path.join(
          this.options.homeDirectory,
          this.platform === 'darwin' ? '.zprofile' : '.zshrc'
        )
      case 'bash':
        return path.join(
          this.options.homeDirectory,
          this.platform === 'darwin' ? '.bash_profile' : '.bashrc'
        )
      case 'bash-login':
        return path.join(this.options.homeDirectory, '.bash_login')
      case 'fish':
        return path.join(
          this.options.homeDirectory,
          '.config',
          'fish',
          'conf.d',
          'deepchat-cli.fish'
        )
      case 'profile':
        return path.join(this.options.homeDirectory, '.profile')
    }
  }

  private async inspectProfile(kind: PosixProfileKind | null): Promise<ProfileInspection | null> {
    if (!kind) return null
    const profilePath = this.profilePath(kind)
    if (!isPathWithin(this.options.homeDirectory, profilePath)) {
      throw new Error('Shell configuration path is outside the user home directory')
    }
    let content = ''
    let exists = false
    try {
      const stats = await lstat(profilePath)
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return { kind, path: profilePath, content, exists: true, blockState: 'modified' }
      }
      if (stats.size > MAX_SHELL_CONFIG_BYTES) {
        return { kind, path: profilePath, content, exists: true, blockState: 'modified' }
      }
      content = await readFile(profilePath, 'utf8')
      exists = true
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    return {
      kind,
      path: profilePath,
      content,
      exists,
      blockState: inspectManagedBlock(content, managedProfileBlock(kind))
    }
  }

  private async hasOrphanedManagedBlock(): Promise<boolean> {
    if (this.platform === 'win32') return false
    for (const kind of ['zsh', 'bash', 'bash-login', 'fish', 'profile'] as const) {
      const profile = await this.inspectProfile(kind)
      if (profile && profile.blockState !== 'missing') return true
    }
    return false
  }

  private markerForSource(
    source: CliSource,
    profileKind: PosixProfileKind | null,
    profilePrefixLength: 0 | 1 | 2,
    profileCreated: boolean
  ): LauncherMarker {
    const commandPath = this.commandPath
    if (!commandPath) throw new Error('CLI launcher command path is unavailable')
    if (this.platform === 'win32') {
      return {
        version: LAUNCHER_MARKER_VERSION,
        platform: 'windows',
        commandPath,
        commandHash: sha256(createWindowsCommand(source))
      }
    }
    return {
      version: LAUNCHER_MARKER_VERSION,
      platform: 'posix',
      commandPath,
      launcherTarget: source.posixLauncher,
      profileKind,
      profilePrefixLength,
      profileCreated
    }
  }

  private async inspectOwnedCommand(
    marker: LauncherMarker
  ): Promise<'current' | 'missing' | 'modified'> {
    try {
      if (marker.platform === 'posix') {
        const target = await this.readPosixCommandTarget()
        if (target === null) return 'missing'
        return target === path.resolve(marker.launcherTarget) ? 'current' : 'modified'
      }
      const content = await this.readWindowsCommand()
      if (content === null) return 'missing'
      return sha256(content) === marker.commandHash ? 'current' : 'modified'
    } catch {
      return 'modified'
    }
  }

  private async captureOwnedCommand(marker: LauncherMarker | null): Promise<string | null> {
    if (this.platform === 'win32') {
      const content = await this.readWindowsCommand()
      if (content === null) return null
      if (!marker || marker.platform !== 'windows' || sha256(content) !== marker.commandHash) {
        throw new Error('Refusing to replace an unowned DeepChat CLI command')
      }
      return content
    }
    const target = await this.readPosixCommandTarget()
    if (target === null) return null
    if (!marker || marker.platform !== 'posix' || target !== path.resolve(marker.launcherTarget)) {
      throw new Error('Refusing to replace an unowned DeepChat CLI command')
    }
    return target
  }

  private async writeOwnedCommand(
    source: CliSource,
    previousCommand: string | null
  ): Promise<void> {
    const commandPath = this.commandPath
    if (!commandPath) throw new Error('CLI launcher command path is unavailable')
    await this.prepareCommandDirectory(path.dirname(commandPath))
    if (this.platform === 'win32') {
      await this.atomicWriteText(commandPath, createWindowsCommand(source), previousCommand, 0o755)
      return
    }
    await this.atomicWriteLink(commandPath, source.posixLauncher, previousCommand)
  }

  private commandForSource(source: CliSource): string {
    return this.platform === 'win32'
      ? createWindowsCommand(source)
      : path.resolve(source.posixLauncher)
  }

  private async restoreOwnedCommand(
    previousCommand: string | null,
    expectedCurrent: string | null
  ): Promise<void> {
    const commandPath = this.commandPath
    if (!commandPath) return
    if (previousCommand === null) {
      if (expectedCurrent === null) return
      if (this.platform === 'win32') {
        await this.unlinkTextIfMatches(commandPath, expectedCurrent)
      } else {
        await this.unlinkLinkIfMatches(commandPath, expectedCurrent)
      }
      return
    }
    if (this.platform === 'win32') {
      await this.atomicWriteText(commandPath, previousCommand, expectedCurrent, 0o755)
    } else {
      await this.atomicWriteLink(commandPath, previousCommand, expectedCurrent)
    }
  }

  private async removeOwnedCommand(previousCommand: string): Promise<void> {
    const commandPath = this.commandPath
    if (!commandPath) return
    if (this.platform === 'win32') {
      await this.unlinkTextIfMatches(commandPath, previousCommand)
    } else {
      await this.unlinkLinkIfMatches(commandPath, previousCommand)
    }
  }

  private async readPosixCommandTarget(): Promise<string | null> {
    const commandPath = this.commandPath
    if (!commandPath) return null
    try {
      const stats = await lstat(commandPath)
      if (!stats.isSymbolicLink()) throw new Error('DeepChat CLI command is not a symbolic link')
      const target = await readlink(commandPath)
      return path.resolve(path.dirname(commandPath), target)
    } catch (error) {
      if (isMissingFileError(error)) return null
      throw error
    }
  }

  private async readWindowsCommand(): Promise<string | null> {
    const commandPath = this.commandPath
    if (!commandPath) return null
    try {
      const stats = await lstat(commandPath)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
        throw new Error('DeepChat CLI command is not an owned launcher file')
      }
      return await readFile(commandPath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) return null
      throw error
    }
  }

  private async prepareCommandDirectory(directory: string): Promise<void> {
    if (this.platform !== 'win32') {
      await this.prepareHomeManagedDirectory(directory)
      return
    }
    await mkdir(directory, { recursive: true, mode: 0o755 })
    const stats = await lstat(directory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('CLI launcher directory is not a real directory')
    }
  }

  private async prepareHomeManagedDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o755 })
    const stats = await lstat(directory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Managed user directory is not a real directory')
    }
    const [physicalHome, physicalDirectory] = await Promise.all([
      realpath(this.options.homeDirectory),
      realpath(directory)
    ])
    if (!isPathWithin(physicalHome, physicalDirectory)) {
      throw new Error('Managed user directory is outside the user home directory')
    }
  }

  private async atomicWriteLink(
    commandPath: string,
    target: string,
    expectedTarget: string | null
  ): Promise<void> {
    const currentTarget = await this.readPosixCommandTarget()
    if (currentTarget !== (expectedTarget && path.resolve(expectedTarget))) {
      throw new Error('CLI launcher changed during installation')
    }
    const tempPath = path.join(path.dirname(commandPath), `.deepchat-${randomUUID()}.tmp`)
    try {
      await symlink(path.resolve(target), tempPath)
      const verifiedTarget = await this.readPosixCommandTarget()
      if (verifiedTarget !== currentTarget)
        throw new Error('CLI launcher changed during installation')
      await rename(tempPath, commandPath)
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      throw error
    }
  }

  private async atomicWriteText(
    filePath: string,
    content: string,
    expectedContent: string | null,
    mode: number
  ): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 })
    const currentContent = await this.readRegularText(
      filePath,
      Math.max(MAX_SHELL_CONFIG_BYTES, 64 * 1024)
    )
    if (currentContent !== expectedContent) throw new Error('Managed file changed during operation')
    const tempPath = path.join(path.dirname(filePath), `.deepchat-${randomUUID()}.tmp`)
    try {
      await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode })
      if (this.platform !== 'win32') await chmod(tempPath, mode)
      const verifiedContent = await this.readRegularText(
        filePath,
        Math.max(MAX_SHELL_CONFIG_BYTES, 64 * 1024)
      )
      if (verifiedContent !== currentContent)
        throw new Error('Managed file changed during operation')
      await rename(tempPath, filePath)
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      throw error
    }
  }

  private async restoreTextFile(
    filePath: string,
    previousContent: string | null,
    currentContent: string | null
  ): Promise<void> {
    if (previousContent === null) {
      if (currentContent === null) return
      await this.unlinkTextIfMatches(filePath, currentContent)
      return
    }
    await this.atomicWriteText(filePath, previousContent, currentContent, 0o644)
  }

  private async readRegularText(filePath: string, maxBytes: number): Promise<string | null> {
    try {
      const stats = await lstat(filePath)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
        throw new Error('Managed path is not a supported regular file')
      }
      return await readFile(filePath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) return null
      throw error
    }
  }

  private async unlinkLinkIfMatches(commandPath: string, expectedTarget: string): Promise<void> {
    const currentTarget = await this.readPosixCommandTarget()
    if (currentTarget !== path.resolve(expectedTarget)) {
      throw new Error('Refusing to remove a changed CLI launcher')
    }
    await unlink(commandPath)
  }

  private async unlinkTextIfMatches(filePath: string, expectedContent: string): Promise<void> {
    const currentContent = await this.readRegularText(filePath, 64 * 1024)
    if (currentContent !== expectedContent) {
      throw new Error('Refusing to remove a changed CLI launcher')
    }
    await unlink(filePath)
  }

  private async pathEntryExists(filePath: string): Promise<boolean> {
    try {
      await lstat(filePath)
      return true
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }

  private async readMarker(): Promise<MarkerReadResult> {
    try {
      const directory = path.dirname(this.markerPath)
      const directoryStats = await lstat(directory)
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        return { state: 'invalid', raw: '' }
      }
      const [physicalUserData, physicalDirectory] = await Promise.all([
        realpath(this.options.userDataDirectory),
        realpath(directory)
      ])
      if (!isPathWithin(physicalUserData, physicalDirectory)) {
        return { state: 'invalid', raw: '' }
      }
      const stats = await lstat(this.markerPath)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MARKER_BYTES) {
        return { state: 'invalid', raw: '' }
      }
      const raw = await readFile(this.markerPath, 'utf8')
      const marker = parseLauncherMarker(JSON.parse(raw))
      return marker ? { state: 'valid', raw, marker } : { state: 'invalid', raw }
    } catch (error) {
      if (isMissingFileError(error)) return { state: 'missing', raw: null }
      if (error instanceof SyntaxError) return { state: 'invalid', raw: '' }
      throw error
    }
  }

  private async writeMarker(content: string, expectedContent: string | null): Promise<void> {
    const directory = path.dirname(this.markerPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const directoryStats = await lstat(directory)
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error('CLI launcher ownership directory is not a real directory')
    }
    const [physicalUserData, physicalDirectory] = await Promise.all([
      realpath(this.options.userDataDirectory),
      realpath(directory)
    ])
    if (!isPathWithin(physicalUserData, physicalDirectory)) {
      throw new Error('CLI launcher ownership directory is outside application data')
    }
    if (this.platform !== 'win32') await chmod(directory, 0o700)
    await this.atomicWriteText(this.markerPath, content, expectedContent, 0o600)
  }

  private async removeMarker(expectedContent: string): Promise<void> {
    await this.unlinkTextIfMatches(this.markerPath, expectedContent)
  }
}
