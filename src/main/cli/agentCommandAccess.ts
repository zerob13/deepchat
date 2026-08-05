import * as fs from 'node:fs'
import path from 'node:path'
import { LOCAL_CONTROL_AGENT_TOKEN_ENV } from '@shared/contracts/localControl'
import type { CommandPermissionService } from '@/tool/permission/commandPermissionService'
import type { AgentCliTokenAuthority } from './agentTokenAuthority'

const AGENT_CLI_COMMAND_PATTERN = /^deepchat\s+[a-z][a-z0-9-]*\s+[a-z][a-z0-9-]*(?:\s|$)/
const AGENT_CLI_COMMAND_TOKEN_TTL_MS = 5 * 60_000

export type AgentCliCommandAccessOptions = Readonly<{
  tokenAuthority: Pick<AgentCliTokenAuthority, 'issue'>
  commandPermission: Pick<CommandPermissionService, 'extractBaseCommand' | 'hasShellControlSyntax'>
  resolveCliDirectory(): string | null
}>

export function resolveBundledCliDirectory(
  input: Readonly<{
    appPath: string
    resourcesPath: string
    isPackaged: boolean
    platform?: NodeJS.Platform
    isFile?: (filePath: string) => boolean
  }>
): string | null {
  const platform = input.platform ?? process.platform
  const directory = input.isPackaged
    ? path.join(input.resourcesPath, 'app.asar.unpacked', 'cli')
    : path.join(input.appPath, 'out', 'cli')
  const launcher = path.join(directory, platform === 'win32' ? 'deepchat.cmd' : 'deepchat')
  if (input.isFile) return input.isFile(launcher) ? directory : null
  try {
    return fs.statSync(launcher).isFile() ? directory : null
  } catch {
    return null
  }
}

export class AgentCliCommandAccess {
  constructor(private readonly options: AgentCliCommandAccessOptions) {}

  createEnvironment(conversationId: string, command: string): Record<string, string> | undefined {
    const normalizedConversationId = conversationId.trim()
    const normalizedCommand = command.trim()
    if (
      !normalizedConversationId ||
      this.options.commandPermission.extractBaseCommand(normalizedCommand) !== 'deepchat' ||
      this.options.commandPermission.hasShellControlSyntax(normalizedCommand) ||
      !AGENT_CLI_COMMAND_PATTERN.test(normalizedCommand) ||
      normalizedCommand.includes(LOCAL_CONTROL_AGENT_TOKEN_ENV)
    ) {
      return undefined
    }

    const cliDirectory = this.options.resolveCliDirectory()
    if (!cliDirectory) return undefined
    const issued = this.options.tokenAuthority.issue({
      conversationId: normalizedConversationId,
      ttlMs: AGENT_CLI_COMMAND_TOKEN_TTL_MS,
      maxCalls: 1
    })
    return {
      [LOCAL_CONTROL_AGENT_TOKEN_ENV]: issued.token,
      PATH: cliDirectory
    }
  }
}
