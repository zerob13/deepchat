import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_CONTROL_AGENT_TOKEN_ENV } from '@shared/contracts/localControl'
import { AgentCliCommandAccess, resolveBundledCliDirectory } from '@/cli/agentCommandAccess'
import { AgentCliTokenAuthority } from '@/cli/agentTokenAuthority'
import { CommandPermissionService } from '@/tool/permission/commandPermissionService'

const temporaryDirectories: string[] = []

async function createCliDirectory(platform: NodeJS.Platform = 'darwin') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deepchat-agent-cli-'))
  temporaryDirectories.push(root)
  const directory = path.join(root, 'out', 'cli')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, platform === 'win32' ? 'deepchat.cmd' : 'deepchat'), '')
  return { root, directory }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('AgentCliCommandAccess', () => {
  it('issues one scoped call only for a standalone two-token CLI command', async () => {
    const { directory } = await createCliDirectory()
    const agentToken = 'a'.repeat(43)
    const authority = new AgentCliTokenAuthority({
      now: () => 1_000,
      createToken: () => agentToken,
      createTokenId: () => 'token-id-conversation-1'
    })
    const access = new AgentCliCommandAccess({
      tokenAuthority: authority,
      commandPermission: new CommandPermissionService(),
      resolveCliDirectory: () => directory
    })

    const environment = access.createEnvironment(
      ' conversation-1 ',
      'deepchat model invoke --prompt hello --jsonl'
    )

    expect(environment).toEqual({
      [LOCAL_CONTROL_AGENT_TOKEN_ENV]: agentToken,
      PATH: directory
    })
    const first = authority.beginRequest(agentToken)
    expect(first.status).toBe('granted')
    if (first.status !== 'granted') throw new Error('Expected Agent CLI grant')
    expect(first.grant.claims).toMatchObject({
      conversationId: 'conversation-1',
      expiresAt: 301_000,
      scopes: expect.arrayContaining(['models:invoke'])
    })
    first.grant.release()
    expect(authority.beginRequest(agentToken)).toEqual({ status: 'quota-exhausted' })
  })

  it.each([
    'deepchat --json model invoke',
    'deepchat model',
    'deepchat model invoke > output.txt',
    'deepchat model invoke | tee output.txt',
    'FOO=bar deepchat model invoke',
    `deepchat model invoke --prompt $${LOCAL_CONTROL_AGENT_TOKEN_ENV}`,
    'ls -la'
  ])('does not issue authority for %j', async (command) => {
    const { directory } = await createCliDirectory()
    const authority = new AgentCliTokenAuthority()
    const access = new AgentCliCommandAccess({
      tokenAuthority: authority,
      commandPermission: new CommandPermissionService(),
      resolveCliDirectory: () => directory
    })

    expect(access.createEnvironment('conversation-1', command)).toBeUndefined()
    expect(authority.snapshot()).toEqual({ tokens: 0, conversations: 0 })
  })

  it('fails closed without a built launcher', () => {
    const authority = new AgentCliTokenAuthority()
    const access = new AgentCliCommandAccess({
      tokenAuthority: authority,
      commandPermission: new CommandPermissionService(),
      resolveCliDirectory: () => null
    })

    expect(access.createEnvironment('conversation-1', 'deepchat cli status')).toBeUndefined()
    expect(authority.snapshot()).toEqual({ tokens: 0, conversations: 0 })
  })
})

describe('resolveBundledCliDirectory', () => {
  it('finds development and packaged launchers without guessing a missing path', async () => {
    const development = await createCliDirectory()
    expect(
      resolveBundledCliDirectory({
        appPath: development.root,
        resourcesPath: '/unused',
        isPackaged: false,
        platform: 'darwin',
        isFile: (filePath) => filePath === path.join(development.directory, 'deepchat')
      })
    ).toBe(development.directory)

    const packagedRoot = await mkdtemp(path.join(os.tmpdir(), 'deepchat-packaged-cli-'))
    temporaryDirectories.push(packagedRoot)
    const packagedDirectory = path.join(packagedRoot, 'app.asar.unpacked', 'cli')
    await mkdir(packagedDirectory, { recursive: true })
    await writeFile(path.join(packagedDirectory, 'deepchat.cmd'), '')
    expect(
      resolveBundledCliDirectory({
        appPath: '/unused',
        resourcesPath: packagedRoot,
        isPackaged: true,
        platform: 'win32',
        isFile: (filePath) => filePath === path.join(packagedDirectory, 'deepchat.cmd')
      })
    ).toBe(packagedDirectory)
    expect(
      resolveBundledCliDirectory({
        appPath: '/missing',
        resourcesPath: '/missing',
        isPackaged: false,
        platform: 'linux',
        isFile: () => false
      })
    ).toBeNull()
  })
})
