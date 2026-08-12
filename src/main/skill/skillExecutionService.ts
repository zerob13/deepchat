import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import logger from '@shared/logger'
import type {
  SkillRuntimePreference,
  SkillRuntimePolicy,
  SkillScriptRuntime
} from '@shared/types/skill'
import { backgroundExecSessionManager } from '@/agent/shared/process/backgroundExecSessionManager'
import {
  RTK_ENABLED_SETTING_KEY,
  rtkRuntimeService
} from '@/agent/shared/process/rtkRuntimeService'
import { getShellEnvironment, mergeCommandEnvironment } from '@/agent/shared/process/shellEnvHelper'
import {
  createUtf8OutputDecoderPair,
  prepareProcessEnvForUtf8Output,
  prepareShellCommandForUtf8Output
} from '@/agent/shared/process/shellOutputEncoding'
import { resolveSessionDir } from '@/agent/shared/storage/sessionPaths'
import { resolveUsableSpawnCwd } from '@/agent/shared/process/spawnGuard'
import { terminateProcessTree } from '@/agent/shared/process/processTree'
import { RuntimeHelper } from '@/lib/runtimeHelper'
import type { SettingsStore } from '@/config/settingsStore'
import type { CommandShellDialect, ResolvedCommandShell } from '@shared/commandShell'
import type { ResolvedSkillExecutionAuthority } from './skillExecutionAuthority'
import {
  materializeSkillExecutionPackageTree,
  type MaterializedSkillExecutionPackageTree
} from './skillExecutionPackageTree'
import { canonicalSkillExecutionPackagePath } from '@/tape/domain/skillMaterialization'

const DEFAULT_TIMEOUT_MS = 120000
const FOREGROUND_OFFLOAD_THRESHOLD = 10000
const FOREGROUND_PREVIEW_CHARS = 12000
const FOREGROUND_KILL_GRACE_MS = 2000

export interface SkillRunRequest {
  skill: string
  script: string
  args?: string[]
  stdin?: string
  background?: boolean
  timeoutMs?: number
}

export interface SkillRunOptions {
  conversationId: string
  commandShell: ResolvedCommandShell
  outputPreviewChars?: number
  assertAuthorityCurrent: () => Promise<void>
  beforeExecute?: (normalizedArguments: Record<string, unknown>) => void
}

interface SkillExecutionServiceOptions {
  resolveConversationWorkdir?: (conversationId: string) => Promise<string | null>
}

interface SkillExecutionResult {
  output: string | { status: 'running'; sessionId: string }
  rtkApplied: boolean
  rtkMode: 'rewrite' | 'direct' | 'bypass'
  rtkFallbackReason?: string
  outputOffloadPath?: string
}

interface RuntimeCommand {
  command: string
  argsPrefix?: string[]
  mode: 'uv' | 'python' | 'node' | 'shell'
}

interface MaterializedSkillScript {
  relativePath: string
  absolutePath: string
  runtime: SkillScriptRuntime
  enabled: boolean
}

interface SpawnPlan {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  shellCommand?: string
  outputPrefix: string
  spawnMode: 'direct' | 'shell'
}

export class SkillExecutionService {
  private readonly runtimeHelper = RuntimeHelper.getInstance()
  private readonly settings: Pick<SettingsStore, 'get'>
  private readonly resolveConversationWorkdir?: (conversationId: string) => Promise<string | null>

  constructor(settings: Pick<SettingsStore, 'get'>, options: SkillExecutionServiceOptions = {}) {
    this.settings = settings
    this.resolveConversationWorkdir = options.resolveConversationWorkdir
    this.runtimeHelper.initializeRuntimes()
  }

  async execute(
    input: SkillRunRequest,
    authority: ResolvedSkillExecutionAuthority,
    options: SkillRunOptions
  ): Promise<SkillExecutionResult> {
    await options.assertAuthorityCurrent()
    const tree = await materializeSkillExecutionPackageTree(authority.executionPackage)
    let ownershipTransferred = false
    try {
      await options.assertAuthorityCurrent()
      const preparedPlan = await this.preparePlanForExecution(
        await this.buildSpawnPlan(
          input,
          authority,
          tree,
          options.conversationId,
          options.commandShell
        ),
        options.commandShell
      )
      const plan = { ...preparedPlan, cwd: resolveUsableSpawnCwd(preparedPlan.cwd) }
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const dispatchArguments = {
        skill: input.skill,
        script: input.script,
        args: input.args ?? [],
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        background: input.background === true,
        timeoutMs,
        resolvedCommand: plan.command,
        resolvedArgs: plan.args,
        resolvedCwd: plan.cwd,
        ...(plan.shellCommand === undefined ? {} : { shellCommand: plan.shellCommand }),
        spawnMode: plan.spawnMode,
        packageHash: authority.executionPackage.packageHash
      }
      const assertReadyForDispatch = async (): Promise<void> => {
        await tree.assertIntact()
        await options.assertAuthorityCurrent()
        options.beforeExecute?.(dispatchArguments)
      }

      if (input.background) {
        const displayCommand =
          plan.shellCommand ?? this.formatDirectInvocation(plan.command, plan.args)
        ownershipTransferred = true
        const result = await backgroundExecSessionManager.start(
          options.conversationId,
          displayCommand,
          plan.cwd,
          {
            commandShell: options.commandShell,
            ...(plan.spawnMode === 'direct'
              ? {
                  directInvocation: {
                    executable: plan.command,
                    args: plan.args
                  }
                }
              : {}),
            timeout: timeoutMs,
            env: plan.env,
            previewChars: options.outputPreviewChars ?? FOREGROUND_PREVIEW_CHARS,
            offloadThresholdChars: Math.min(
              FOREGROUND_OFFLOAD_THRESHOLD,
              options.outputPreviewChars ?? FOREGROUND_PREVIEW_CHARS
            ),
            ownedSkillExecutionPackageTree: tree.descriptor
          },
          assertReadyForDispatch
        )

        if (input.stdin !== undefined) {
          try {
            await backgroundExecSessionManager.write(
              options.conversationId,
              result.sessionId,
              input.stdin,
              true
            )
          } catch (error) {
            await backgroundExecSessionManager
              .remove(options.conversationId, result.sessionId)
              .catch((cleanupError) => {
                logger.warn('[SkillExecutionService] Failed to remove background session', {
                  sessionId: result.sessionId,
                  cleanupError
                })
              })
            throw error
          }
        }

        return {
          output: { status: 'running', sessionId: result.sessionId },
          rtkApplied: plan.spawnMode === 'shell',
          rtkMode: plan.spawnMode === 'shell' ? 'rewrite' : 'bypass'
        }
      }

      await assertReadyForDispatch()
      const foregroundResult = await this.runForeground(
        plan,
        timeoutMs,
        options.conversationId,
        options.commandShell,
        input.stdin,
        options.outputPreviewChars ?? FOREGROUND_PREVIEW_CHARS
      )
      if (foregroundResult.releasePackageTree === false) {
        ownershipTransferred = true
        logger.warn('[SkillExecutionService] Retaining package tree for an unclosed process tree', {
          rootPath: tree.rootPath
        })
      }
      return {
        output: foregroundResult.output,
        rtkApplied: plan.spawnMode === 'shell',
        rtkMode: plan.spawnMode === 'shell' ? 'rewrite' : 'bypass',
        outputOffloadPath: foregroundResult.outputOffloadPath
      }
    } finally {
      if (!ownershipTransferred) {
        await tree.cleanup().catch((error) => {
          logger.warn('[SkillExecutionService] Failed to clean foreground package tree', {
            rootPath: tree.rootPath,
            error
          })
        })
      }
    }
  }

  private async buildSpawnPlan(
    input: SkillRunRequest,
    authority: ResolvedSkillExecutionAuthority,
    tree: MaterializedSkillExecutionPackageTree,
    conversationId: string,
    commandShell: ResolvedCommandShell
  ): Promise<SpawnPlan> {
    if (input.skill !== authority.identity.skillName) {
      throw new Error('Skill execution request does not match its request-bound package authority.')
    }

    const script = this.resolveRequestedScript(input.script, authority, tree)
    if (!script.enabled) {
      throw new Error(`Skill script "${script.relativePath}" is disabled`)
    }

    const shellEnv = await getShellEnvironment()
    const executionCwd = await this.resolveExecutionCwd(conversationId, tree.packageRoot)
    const mergedEnv = mergeCommandEnvironment({
      shellEnv,
      overrides: {
        ...authority.environment,
        SKILL_ROOT: tree.packageRoot,
        DEEPCHAT_SKILL_ROOT: tree.packageRoot
      }
    })

    const runtime = await this.resolveRuntimeCommand(
      script,
      authority.executionPackage.runtimePolicy,
      mergedEnv,
      commandShell
    )
    const args = this.buildRuntimeArgs(runtime, script, tree.packageRoot, input.args ?? [])

    return {
      command: runtime.command,
      args,
      cwd: executionCwd,
      env: mergedEnv,
      ...(commandShell.dialect === 'cmd'
        ? {}
        : { shellCommand: this.buildShellCommand(runtime.command, args, commandShell.dialect) }),
      outputPrefix: `skillrun_${input.skill.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      spawnMode: 'direct'
    }
  }

  private async resolveExecutionCwd(conversationId: string, packageRoot: string): Promise<string> {
    const normalizedPackageRoot = path.resolve(packageRoot)
    if (!this.resolveConversationWorkdir) {
      return this.resolveFallbackExecutionCwd(conversationId, normalizedPackageRoot)
    }

    try {
      const resolvedWorkdir = await this.resolveConversationWorkdir(conversationId)
      const normalizedWorkdir = resolvedWorkdir?.trim()
      if (normalizedWorkdir) {
        const resolvedPath = path.resolve(normalizedWorkdir)
        try {
          const stat = await fs.promises.stat(resolvedPath)
          if (stat.isDirectory()) {
            return resolvedPath
          }
          logger.warn('[SkillExecutionService] Conversation workdir is not a directory', {
            conversationId,
            invalidWorkdir: resolvedPath
          })
        } catch (error) {
          logger.warn('[SkillExecutionService] Conversation workdir is invalid', {
            conversationId,
            invalidWorkdir: resolvedPath,
            error
          })
        }
      }
    } catch (error) {
      logger.warn('[SkillExecutionService] Failed to resolve conversation workdir', {
        conversationId,
        error
      })
    }

    logger.warn('[SkillExecutionService] Missing conversation workdir, using session directory', {
      conversationId,
      packageRoot: normalizedPackageRoot
    })
    return this.resolveFallbackExecutionCwd(conversationId, normalizedPackageRoot)
  }

  private resolveFallbackExecutionCwd(conversationId: string, packageRoot: string): string {
    const sessionDir = resolveSessionDir(conversationId)
    if (!sessionDir) {
      return packageRoot
    }

    try {
      fs.mkdirSync(sessionDir, { recursive: true })
      return sessionDir
    } catch (error) {
      logger.warn(
        '[SkillExecutionService] Failed to create session directory, using package root',
        {
          conversationId,
          sessionDir,
          packageRoot,
          error
        }
      )
    }

    return packageRoot
  }

  private resolveRequestedScript(
    requestedScript: string,
    authority: ResolvedSkillExecutionAuthority,
    tree: MaterializedSkillExecutionPackageTree
  ): MaterializedSkillScript {
    let canonicalPath: string
    try {
      canonicalPath = canonicalSkillExecutionPackagePath(requestedScript)
    } catch {
      throw new Error(`Skill script "${requestedScript}" is not a canonical package path`)
    }
    const executable = authority.executionPackage.executables.find(
      (candidate) => candidate.relativePath === canonicalPath
    )
    if (!executable) throw new Error(`Skill script "${requestedScript}" not found in package`)

    return {
      ...executable,
      absolutePath: tree.resolveFile(executable.relativePath)
    }
  }

  private async resolveRuntimeCommand(
    script: MaterializedSkillScript,
    runtimePolicy: SkillRuntimePolicy,
    env: Record<string, string>,
    commandShell: ResolvedCommandShell
  ): Promise<RuntimeCommand> {
    if (script.runtime === 'shell') {
      if (commandShell.profile !== 'posix' && commandShell.profile !== 'git-bash') {
        throw new Error('Shell skill scripts on Windows require the Git Bash command shell')
      }
      return { command: commandShell.executable, mode: 'shell' }
    }

    if (script.runtime === 'node') {
      return await this.resolveNodeRuntime(runtimePolicy.node, env)
    }

    return await this.resolvePythonRuntime(runtimePolicy.python, env)
  }

  private async resolvePythonRuntime(
    preference: SkillRuntimePreference,
    env: Record<string, string>
  ): Promise<RuntimeCommand> {
    if (preference === 'builtin') {
      const bundledUv = this.getBundledRuntimeCommand('uv')
      if (!bundledUv) {
        throw new Error('Bundled uv runtime is not available')
      }
      return { command: bundledUv, mode: 'uv' }
    }

    if (preference === 'system') {
      const system = await this.findSystemPythonRuntime(env)
      if (!system) {
        throw new Error('No compatible system Python runtime found for this skill')
      }
      return system
    }

    if (await this.hasCommand('uv', ['--version'], env)) {
      return { command: 'uv', mode: 'uv' }
    }

    const bundledUv = this.getBundledRuntimeCommand('uv')
    if (bundledUv) {
      return { command: bundledUv, mode: 'uv' }
    }

    const fallback = await this.findSystemPythonRuntime(env)
    if (!fallback) {
      throw new Error('No compatible Python runtime found for this skill')
    }
    return fallback
  }

  private async resolveNodeRuntime(
    preference: SkillRuntimePreference,
    env: Record<string, string>
  ): Promise<RuntimeCommand> {
    if (preference === 'builtin') {
      const bundledNode = this.getBundledRuntimeCommand('node')
      if (!bundledNode) {
        throw new Error('Bundled node runtime is not available')
      }
      return { command: bundledNode, mode: 'node' }
    }

    if (preference === 'system') {
      if (!(await this.hasCommand('node', ['--version'], env))) {
        throw new Error('System node runtime is not available')
      }
      return { command: 'node', mode: 'node' }
    }

    if (await this.hasCommand('node', ['--version'], env)) {
      return { command: 'node', mode: 'node' }
    }

    const bundledNode = this.getBundledRuntimeCommand('node')
    if (!bundledNode) {
      throw new Error('No compatible node runtime found for this skill')
    }
    return { command: bundledNode, mode: 'node' }
  }

  private async findSystemPythonRuntime(
    env: Record<string, string>
  ): Promise<RuntimeCommand | null> {
    const candidates: Array<{ command: string; probeArgs: string[]; argsPrefix?: string[] }> =
      process.platform === 'win32'
        ? [
            { command: 'python', probeArgs: ['--version'] },
            { command: 'py', probeArgs: ['-3', '--version'], argsPrefix: ['-3'] }
          ]
        : [
            { command: 'python3', probeArgs: ['--version'] },
            { command: 'python', probeArgs: ['--version'] }
          ]

    for (const candidate of candidates) {
      if (await this.hasCommand(candidate.command, candidate.probeArgs, env)) {
        return {
          command: candidate.command,
          argsPrefix: candidate.argsPrefix,
          mode: 'python'
        }
      }
    }

    return null
  }

  private buildRuntimeArgs(
    runtime: RuntimeCommand,
    script: MaterializedSkillScript,
    packageRoot: string,
    args: string[]
  ): string[] {
    if (runtime.mode === 'uv') {
      const commandArgs = ['run']
      if (fs.existsSync(path.join(packageRoot, 'pyproject.toml'))) {
        commandArgs.push('--project', packageRoot)
      }
      commandArgs.push(script.absolutePath, ...args)
      return commandArgs
    }

    if (runtime.mode === 'python') {
      return [...(runtime.argsPrefix ?? []), script.absolutePath, ...args]
    }

    if (runtime.mode === 'node') {
      return [script.absolutePath, ...args]
    }

    return [script.absolutePath, ...args]
  }

  private async runForeground(
    plan: SpawnPlan,
    timeoutMs: number,
    conversationId: string,
    commandShell: ResolvedCommandShell,
    stdin?: string,
    outputPreviewChars = FOREGROUND_PREVIEW_CHARS
  ): Promise<{ output: string; outputOffloadPath?: string; releasePackageTree: boolean }> {
    const outputFilePath = this.createForegroundOutputPath(conversationId, plan.outputPrefix)
    const offloadThresholdChars = Math.min(FOREGROUND_OFFLOAD_THRESHOLD, outputPreviewChars)

    return await new Promise((resolve, reject) => {
      const shellRuntime = plan.spawnMode === 'shell' ? commandShell : null
      if (shellRuntime && plan.shellCommand === undefined) {
        reject(new Error('Shell spawn plan is missing a serialized command'))
        return
      }
      const command = shellRuntime ? shellRuntime.executable : plan.command
      const shellCommand = shellRuntime
        ? prepareShellCommandForUtf8Output(shellRuntime.dialect, plan.shellCommand ?? '')
        : undefined
      const args = shellRuntime ? [...shellRuntime.args, shellCommand ?? ''] : plan.args
      const env = prepareProcessEnvForUtf8Output(plan.env)
      const child = spawn(command, args, {
        cwd: plan.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      })

      let outputBuffer = ''
      let totalOutputLength = 0
      let offloaded = false
      let offloadDisabled = outputFilePath === null
      let activeOutputFilePath = outputFilePath
      let timedOut = false
      let outputWriteQueue = Promise.resolve()
      let timeoutId: NodeJS.Timeout | null = null
      let settled = false
      let releasePackageTree = true

      const outputDecoders = createUtf8OutputDecoderPair((data) => appendOutput(data))

      const cleanupTimers = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
      }

      const settleUnclosedProcessTree = () => {
        if (settled) return
        releasePackageTree = false
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
        if (typeof child.unref === 'function') {
          child.unref()
        }
        void settleProcess(null)
      }

      const settleProcess = async (code: number | null, error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        cleanupTimers()
        child.removeAllListeners('error')
        child.removeAllListeners('close')
        outputDecoders.flush()

        try {
          await outputWriteQueue
        } catch {
          // Already logged when the queue failed.
        }

        if (error) {
          reject(error)
          return
        }

        const preview =
          offloaded && activeOutputFilePath
            ? this.readLastCharsFromFile(activeOutputFilePath, outputPreviewChars)
            : outputBuffer

        const lines: string[] = []
        if (preview.trim()) {
          lines.push(preview.trimEnd())
        }
        lines.push(`Exit Code: ${code ?? 'null'}`)
        if (timedOut) {
          lines.push('Timed out')
        }
        if (offloaded && activeOutputFilePath) {
          lines.push(`Output offloaded: ${activeOutputFilePath}`)
        }
        resolve({
          output: lines.join('\n'),
          outputOffloadPath: offloaded ? (activeOutputFilePath ?? undefined) : undefined,
          releasePackageTree
        })
      }

      const appendToOutputBuffer = (data: string) => {
        if (!data) {
          return
        }

        outputBuffer += data
        if (outputBuffer.length > outputPreviewChars) {
          outputBuffer = outputBuffer.slice(-outputPreviewChars)
        }
      }

      const disableOffload = (data: string) => {
        const filePreview =
          offloaded && activeOutputFilePath
            ? this.readLastCharsFromFile(activeOutputFilePath, outputPreviewChars)
            : ''

        offloaded = false
        offloadDisabled = true
        activeOutputFilePath = null
        outputBuffer = ''
        appendToOutputBuffer(filePreview)
        appendToOutputBuffer(data)
      }

      const queueOutputWrite = (data: string) => {
        if (offloadDisabled || !activeOutputFilePath || !data) {
          offloaded = false
          appendToOutputBuffer(data)
          return
        }

        const targetOutputFilePath = activeOutputFilePath
        outputWriteQueue = outputWriteQueue
          .then(async () => {
            if (
              !targetOutputFilePath ||
              offloadDisabled ||
              activeOutputFilePath !== targetOutputFilePath
            ) {
              appendToOutputBuffer(data)
              return
            }

            await fs.promises.appendFile(targetOutputFilePath, data, 'utf-8')
          })
          .catch((error) => {
            logger.warn('[SkillExecutionService] Failed to flush foreground output', {
              outputFilePath: targetOutputFilePath,
              error
            })
            disableOffload(data)
          })
      }

      const appendOutput = (data: string) => {
        totalOutputLength += data.length
        const shouldOffload =
          !offloadDisabled &&
          activeOutputFilePath !== null &&
          (offloaded || totalOutputLength > offloadThresholdChars)

        if (!shouldOffload) {
          appendToOutputBuffer(data)
          return
        }

        offloaded = true
        const chunk = outputBuffer + data
        outputBuffer = ''
        queueOutputWrite(chunk)
      }

      child.stdout?.on('data', (data: Buffer | string) => outputDecoders.writeStdout(data))
      child.stderr?.on('data', (data: Buffer | string) => outputDecoders.writeStderr(data))

      if (stdin !== undefined) {
        child.stdin?.write(stdin)
      }
      child.stdin?.end()

      timeoutId = setTimeout(() => {
        timedOut = true
        void terminateProcessTree(child, { graceMs: FOREGROUND_KILL_GRACE_MS })
          .then((closed) => {
            if (closed || settled) return
            settleUnclosedProcessTree()
          })
          .catch((error) => {
            logger.warn('[SkillExecutionService] Failed to terminate timed-out process tree', {
              error
            })
            settleUnclosedProcessTree()
          })
      }, timeoutMs)

      child.on('error', (error) => {
        void settleProcess(null, error)
      })

      child.on('close', async (code) => {
        void settleProcess(code ?? null)
      })
    })
  }

  private async preparePlanForExecution(
    plan: SpawnPlan,
    commandShell: ResolvedCommandShell
  ): Promise<SpawnPlan> {
    if (commandShell.dialect === 'cmd') {
      if (plan.spawnMode === 'shell') {
        throw new Error('Skill shell execution is unavailable under Command Prompt')
      }
      return {
        ...plan,
        shellCommand: undefined,
        env: await rtkRuntimeService.prepareExecutionEnv(plan.env)
      }
    }

    if (commandShell.dialect === 'powershell') {
      if (plan.spawnMode === 'shell') {
        throw new Error('Skill shell execution is unavailable under Windows PowerShell')
      }
      return {
        ...plan,
        shellCommand: undefined,
        env: await rtkRuntimeService.prepareExecutionEnv(plan.env)
      }
    }

    if (plan.shellCommand === undefined) {
      throw new Error('Shell-capable skill plan is missing a serialized command')
    }

    const prepared = await rtkRuntimeService.prepareShellCommand(
      plan.shellCommand,
      plan.env,
      this.settings.get<boolean>(RTK_ENABLED_SETTING_KEY) !== false
    )

    if (!prepared.rewritten) {
      return {
        ...plan,
        env: prepared.env
      }
    }

    return {
      ...plan,
      env: prepared.env,
      shellCommand: prepared.command,
      spawnMode: 'shell'
    }
  }

  private buildShellCommand(
    command: string,
    args: string[],
    dialect: Exclude<CommandShellDialect, 'cmd'>
  ): string {
    const invocation = [command, ...args]
      .map((token) => this.quoteForShell(token, dialect))
      .join(' ')
    return dialect === 'powershell' ? `& ${invocation}` : invocation
  }

  private quoteForShell(token: string, dialect: Exclude<CommandShellDialect, 'cmd'>): string {
    if (dialect === 'powershell') return `'${token.replace(/'/g, "''")}'`
    return `'${token.replace(/'/g, `'\\''`)}'`
  }

  private formatDirectInvocation(command: string, args: string[]): string {
    return [command, ...args].map((token) => JSON.stringify(token)).join(' ')
  }

  private getBundledRuntimeCommand(command: 'uv' | 'node'): string | null {
    this.runtimeHelper.initializeRuntimes()

    if (command === 'uv' && !this.runtimeHelper.getUvRuntimePath()) {
      return null
    }
    if (command === 'node' && !this.runtimeHelper.getNodeRuntimePath()) {
      return null
    }

    const resolved = this.runtimeHelper.replaceWithRuntimeCommand(command, true, true)
    return resolved === command ? null : resolved
  }

  private async hasCommand(
    command: string,
    args: string[],
    env: Record<string, string>
  ): Promise<boolean> {
    return await new Promise((resolve) => {
      const child = spawn(command, args, {
        env,
        stdio: 'ignore',
        shell: false,
        windowsHide: true
      })

      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
  }

  private createForegroundOutputPath(conversationId: string, prefix: string): string | null {
    const sessionDir = resolveSessionDir(conversationId)
    if (!sessionDir) {
      return null
    }

    try {
      fs.mkdirSync(sessionDir, { recursive: true })
      return path.join(sessionDir, `${prefix}_${Date.now()}.log`)
    } catch (error) {
      logger.warn('[SkillExecutionService] Failed to create session directory for output offload', {
        conversationId,
        error
      })
      return null
    }
  }

  private readLastCharsFromFile(filePath: string, maxChars: number): string {
    try {
      const stats = fs.statSync(filePath)
      const fileSize = stats.size
      const bytesToRead = Math.min(maxChars * 4, fileSize)
      const startPosition = Math.max(0, fileSize - bytesToRead)
      const fd = fs.openSync(filePath, 'r')

      try {
        const buffer = Buffer.alloc(bytesToRead)
        fs.readSync(fd, buffer, 0, bytesToRead, startPosition)
        const content = buffer.toString('utf-8')
        if (startPosition > 0) {
          const firstNewline = content.indexOf('\n')
          if (firstNewline > 0) {
            return content.slice(firstNewline + 1).slice(-maxChars)
          }
        }
        return content.slice(-maxChars)
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      logger.warn('[SkillExecutionService] Failed to read preview from offloaded output', {
        filePath,
        error
      })
      return ''
    }
  }
}
