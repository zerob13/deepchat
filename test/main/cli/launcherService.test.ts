import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliLauncherService } from '@/cli/launcherService'

const temporaryDirectories: string[] = []

async function createFixture(platform: NodeJS.Platform = 'darwin') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deepchat-cli-launcher-'))
  temporaryDirectories.push(root)
  const homeDirectory = path.join(root, 'home')
  const userDataDirectory = path.join(root, 'user-data')
  const localAppDataDirectory = path.join(root, 'local-app-data')
  const cliDirectory = path.join(root, 'cli-v1')
  await mkdir(homeDirectory, { recursive: true })
  await mkdir(userDataDirectory, { recursive: true })
  await mkdir(cliDirectory, { recursive: true })
  await writeFile(path.join(cliDirectory, 'deepchat'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(path.join(cliDirectory, 'deepchat.cmd'), '@echo off\r\n')
  await writeFile(path.join(cliDirectory, 'deepchat.mjs'), 'console.log("deepchat")\n')
  let currentCliDirectory: string | null = cliDirectory
  const service = new CliLauncherService({
    platform,
    homeDirectory,
    userDataDirectory,
    localAppDataDirectory,
    environmentPath:
      platform === 'win32'
        ? `${path.join(localAppDataDirectory, 'Microsoft', 'WindowsApps')};C:\\Windows\\System32`
        : '/usr/bin:/bin',
    shell: '/bin/zsh',
    resolveCliDirectory: () => currentCliDirectory
  })
  return {
    root,
    homeDirectory,
    userDataDirectory,
    localAppDataDirectory,
    cliDirectory,
    service,
    setCliDirectory: (directory: string | null) => {
      currentCliDirectory = directory
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('CliLauncherService', () => {
  it('installs and reverses a POSIX launcher without changing existing shell content', async () => {
    const fixture = await createFixture()
    const profilePath = path.join(fixture.homeDirectory, '.zprofile')
    const commandPath = path.join(fixture.homeDirectory, '.local', 'bin', 'deepchat')
    await writeFile(profilePath, 'export EDITOR=vim\n')

    await expect(fixture.service.getStatus()).resolves.toMatchObject({
      state: 'not-installed',
      commandPath,
      shellConfigPath: null
    })
    await expect(fixture.service.setInstalled(true)).resolves.toMatchObject({
      state: 'installed',
      commandPath,
      shellConfigPath: profilePath
    })
    expect(path.resolve(path.dirname(commandPath), await readlink(commandPath))).toBe(
      path.join(fixture.cliDirectory, 'deepchat')
    )
    expect(await readFile(profilePath, 'utf8')).toBe(
      [
        'export EDITOR=vim',
        '',
        '# >>> DeepChat CLI >>>',
        'case ":$PATH:" in',
        '  *":$HOME/.local/bin:"*) ;;',
        '  *) export PATH="$HOME/.local/bin:$PATH" ;;',
        'esac',
        '# <<< DeepChat CLI <<<',
        ''
      ].join('\n')
    )
    expect(
      (await lstat(path.join(fixture.userDataDirectory, 'local-control', 'launcher.json'))).mode &
        0o777
    ).toBe(0o600)

    await expect(fixture.service.setInstalled(false)).resolves.toMatchObject({
      state: 'not-installed'
    })
    await expect(lstat(commandPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(profilePath, 'utf8')).toBe('export EDITOR=vim\n')
    await expect(
      lstat(path.join(fixture.userDataDirectory, 'local-control', 'launcher.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not edit a shell profile when the user command directory is already on PATH', async () => {
    const fixture = await createFixture()
    const binDirectory = path.join(fixture.homeDirectory, '.local', 'bin')
    const service = new CliLauncherService({
      platform: 'linux',
      homeDirectory: fixture.homeDirectory,
      userDataDirectory: fixture.userDataDirectory,
      environmentPath: `/usr/bin:${binDirectory}`,
      shell: '/bin/bash',
      resolveCliDirectory: () => fixture.cliDirectory
    })

    await expect(service.setInstalled(true)).resolves.toMatchObject({
      state: 'installed',
      shellConfigPath: null
    })
    await expect(lstat(path.join(fixture.homeDirectory, '.bashrc'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('restores a profile byte-for-byte and removes a profile it created', async () => {
    const fixture = await createFixture()
    const profilePath = path.join(fixture.homeDirectory, '.zprofile')
    await writeFile(profilePath, 'export EDITOR=vim')

    await fixture.service.setInstalled(true)
    await fixture.service.setInstalled(false)
    expect(await readFile(profilePath, 'utf8')).toBe('export EDITOR=vim')

    await rm(profilePath)
    await fixture.service.setInstalled(true)
    expect((await lstat(profilePath)).isFile()).toBe(true)
    await fixture.service.setInstalled(false)
    await expect(lstat(profilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to overwrite an unowned command or an orphaned managed block', async () => {
    const fixture = await createFixture()
    const commandPath = path.join(fixture.homeDirectory, '.local', 'bin', 'deepchat')
    await mkdir(path.dirname(commandPath), { recursive: true })
    await writeFile(commandPath, 'foreign')

    await expect(fixture.service.getStatus()).resolves.toMatchObject({
      state: 'conflict',
      reason: 'unowned-command'
    })
    await expect(fixture.service.setInstalled(true)).rejects.toThrow('without an ownership marker')
    expect(await readFile(commandPath, 'utf8')).toBe('foreign')

    await rm(commandPath)
    await writeFile(
      path.join(fixture.homeDirectory, '.zprofile'),
      '# >>> DeepChat CLI >>>\ncustom\n# <<< DeepChat CLI <<<\n'
    )
    await expect(fixture.service.setInstalled(true)).rejects.toThrow('without an ownership marker')
  })

  it('fails closed when an owned command or shell block is modified', async () => {
    const fixture = await createFixture()
    const commandPath = path.join(fixture.homeDirectory, '.local', 'bin', 'deepchat')
    const profilePath = path.join(fixture.homeDirectory, '.zprofile')
    await fixture.service.setInstalled(true)
    await rm(commandPath)
    await symlink('/tmp/not-deepchat', commandPath)

    await expect(fixture.service.getStatus()).resolves.toMatchObject({
      state: 'conflict',
      reason: 'command-modified'
    })
    await expect(fixture.service.setInstalled(false)).rejects.toThrow('unowned')
    expect(await readlink(commandPath)).toBe('/tmp/not-deepchat')

    await rm(commandPath)
    await symlink(path.join(fixture.cliDirectory, 'deepchat'), commandPath)
    await writeFile(
      profilePath,
      (await readFile(profilePath, 'utf8'))
        .replace('fish_add_path', 'changed')
        .replace('export PATH=', 'export CHANGED=')
    )
    await expect(fixture.service.getStatus()).resolves.toMatchObject({
      state: 'conflict',
      reason: 'shell-config-modified'
    })
    await expect(fixture.service.setInstalled(false)).rejects.toThrow('modified')
  })

  it('repairs missing owned files only after an explicit install request', async () => {
    const fixture = await createFixture()
    const commandPath = path.join(fixture.homeDirectory, '.local', 'bin', 'deepchat')
    await fixture.service.setInstalled(true)
    await rm(commandPath)

    await expect(fixture.service.getStatus()).resolves.toMatchObject({
      state: 'needs-repair',
      reason: 'command-missing'
    })
    await fixture.service.reconcileOwnedLauncher()
    await expect(lstat(commandPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(fixture.service.setInstalled(true)).resolves.toMatchObject({ state: 'installed' })
    expect((await lstat(commandPath)).isSymbolicLink()).toBe(true)
  })

  it('refreshes only a stale launcher whose previous target is still owned', async () => {
    const fixture = await createFixture()
    const commandPath = path.join(fixture.homeDirectory, '.local', 'bin', 'deepchat')
    await fixture.service.setInstalled(true)
    const nextCliDirectory = path.join(fixture.root, 'cli-v2')
    await mkdir(nextCliDirectory)
    await writeFile(path.join(nextCliDirectory, 'deepchat'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(path.join(nextCliDirectory, 'deepchat.mjs'), 'console.log("v2")\n')
    fixture.setCliDirectory(nextCliDirectory)

    await expect(fixture.service.getStatus()).resolves.toMatchObject({
      state: 'stale',
      reason: 'upgrade-required'
    })
    await fixture.service.reconcileOwnedLauncher()
    expect(path.resolve(path.dirname(commandPath), await readlink(commandPath))).toBe(
      path.join(nextCliDirectory, 'deepchat')
    )
    await expect(fixture.service.getStatus()).resolves.toMatchObject({ state: 'installed' })
  })

  it('uses an owned Windows command shim and refreshes it across app paths', async () => {
    const fixture = await createFixture('win32')
    const commandPath = path.join(
      fixture.localAppDataDirectory,
      'Microsoft',
      'WindowsApps',
      'deepchat.cmd'
    )

    await expect(fixture.service.setInstalled(true)).resolves.toMatchObject({
      state: 'installed',
      commandPath,
      shellConfigPath: null
    })
    expect(await readFile(commandPath, 'utf8')).toContain(
      `set "cli_module=${path.join(fixture.cliDirectory, 'deepchat.mjs')}"`
    )

    const nextCliDirectory = path.join(fixture.root, 'cli-win-v2')
    await mkdir(nextCliDirectory)
    await writeFile(path.join(nextCliDirectory, 'deepchat.mjs'), 'console.log("v2")\n')
    fixture.setCliDirectory(nextCliDirectory)
    await expect(fixture.service.getStatus()).resolves.toMatchObject({ state: 'stale' })
    await fixture.service.reconcileOwnedLauncher()
    expect(await readFile(commandPath, 'utf8')).toContain(
      `set "cli_module=${path.join(nextCliDirectory, 'deepchat.mjs')}"`
    )

    await expect(fixture.service.setInstalled(false)).resolves.toMatchObject({
      state: 'not-installed'
    })
    await expect(lstat(commandPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not claim Windows installation when its user command directory is off PATH', async () => {
    const fixture = await createFixture('win32')
    const service = new CliLauncherService({
      platform: 'win32',
      homeDirectory: fixture.homeDirectory,
      userDataDirectory: fixture.userDataDirectory,
      localAppDataDirectory: fixture.localAppDataDirectory,
      environmentPath: 'C:\\Windows\\System32',
      resolveCliDirectory: () => fixture.cliDirectory
    })

    await expect(service.getStatus()).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'path-unavailable'
    })
    await expect(service.setInstalled(true)).rejects.toThrow('not available on PATH')
  })

  it('reports an unavailable source without creating installation state', async () => {
    const fixture = await createFixture()
    fixture.setCliDirectory(null)

    await expect(fixture.service.getStatus()).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'source-missing'
    })
    await expect(fixture.service.setInstalled(true)).rejects.toThrow('unavailable')
  })

  it('can remove owned integration after the packaged source disappears', async () => {
    const fixture = await createFixture()
    const commandPath = path.join(fixture.homeDirectory, '.local', 'bin', 'deepchat')
    const profilePath = path.join(fixture.homeDirectory, '.zprofile')
    await fixture.service.setInstalled(true)
    fixture.setCliDirectory(null)

    await expect(fixture.service.setInstalled(false)).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'source-missing'
    })
    await expect(lstat(commandPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(profilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
