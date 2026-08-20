import { describe, expect, it } from 'vitest'
import { AcpTerminalAuthRunner } from '@/agent/acp/auth/acpTerminalAuthRunner'

const processEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1]))
  )

describe('AcpTerminalAuthRunner', () => {
  it('runs the authentication command in a PTY with its exact environment', async () => {
    const runner = new AcpTerminalAuthRunner()
    const output: string[] = []
    const started = runner.start({
      ownerWebContentsId: 7,
      launch: {
        command: process.execPath,
        args: [
          '-e',
          "process.stdout.write(process.env.DEEPCHAT_ACP_AUTH_TEST === 'method-wins' ? 'PTY_AUTH_OK' : 'BAD_ENV'); process.exit(process.env.DEEPCHAT_ACP_AUTH_TEST === 'method-wins' ? 0 : 2)"
        ],
        env: { ...processEnvironment(), DEEPCHAT_ACP_AUTH_TEST: 'method-wins' },
        cwd: process.cwd()
      },
      onData: (_runId, data) => output.push(data)
    })

    const exit = await started.completion

    expect(exit).toMatchObject({ exitCode: 0, cancelled: false })
    expect(output.join('')).toContain('PTY_AUTH_OK')
  })
})
