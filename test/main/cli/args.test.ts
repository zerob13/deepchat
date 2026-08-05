import { describe, expect, it } from 'vitest'
import { CLI_OUTPUT_ENV, CLI_TIMEOUT_ENV, parseCliArguments } from '../../../src/cli/args'

describe('CLI argument grammar', () => {
  it('maps the two-token command prefix to a canonical route', () => {
    const parsed = parseCliArguments(['system', 'status'], {})

    expect(parsed).toMatchObject({
      domain: 'system',
      verb: 'status',
      outputMode: 'text',
      timeoutMs: 30_000,
      helpRequested: false
    })
    expect(parsed.contract?.name).toBe('cli.status')
  })

  it('accepts global flags only after the domain and verb', () => {
    expect(parseCliArguments(['system', 'doctor', '--jsonl', '--timeout=2500'], {})).toMatchObject({
      outputMode: 'jsonl',
      timeoutMs: 2_500
    })

    expect(() => parseCliArguments(['--json', 'system', 'doctor'], {})).toThrow(
      'deepchat <domain> <verb>'
    )
    expect(() => parseCliArguments(['system', '--json', 'doctor'], {})).toThrow(
      'deepchat <domain> <verb>'
    )
  })

  it('uses validated environment defaults and explicit output override', () => {
    expect(
      parseCliArguments(['system', 'version', '--json'], {
        [CLI_OUTPUT_ENV]: 'text',
        [CLI_TIMEOUT_ENV]: '9000'
      })
    ).toMatchObject({ outputMode: 'json', timeoutMs: 9_000 })

    expect(() => parseCliArguments(['system', 'version'], { [CLI_OUTPUT_ENV]: 'xml' })).toThrow(
      `${CLI_OUTPUT_ENV} must be`
    )
  })

  it('rejects ambiguous and unbounded options', () => {
    expect(() => parseCliArguments(['system', 'status', '--json', '--jsonl'], {})).toThrow(
      'mutually exclusive'
    )
    expect(() => parseCliArguments(['system', 'status', '--timeout', '1800001'], {})).toThrow(
      'must not exceed'
    )
    expect(() => parseCliArguments(['system', 'status', 'extra'], {})).toThrow('Unknown option')
  })

  it('keeps help inside the two-token grammar', () => {
    expect(parseCliArguments(['help', 'commands'], {})).toMatchObject({
      contract: null,
      helpRequested: true
    })
    expect(() => parseCliArguments(['--help'], {})).toThrow('deepchat <domain> <verb>')
  })

  it('parses artifact ownership commands without accepting output flags on metadata operations', () => {
    const id = 'artifact_identifier_123'

    expect(
      parseCliArguments(['artifact', 'get', '--id', id, '--out', './image.png', '--overwrite'], {})
    ).toMatchObject({
      operation: 'download',
      params: { id },
      outputPath: './image.png',
      overwrite: true
    })
    expect(parseCliArguments(['artifact', 'describe', `--id=${id}`], {})).toMatchObject({
      operation: 'rpc',
      params: { id }
    })
    expect(() =>
      parseCliArguments(['artifact', 'delete', '--id', id, '--out', './invalid'], {})
    ).toThrow('only valid for deepchat artifact get')
    expect(() => parseCliArguments(['artifact', 'get', '--id', id], {})).toThrow('requires --out')
    expect(() =>
      parseCliArguments(['artifact', 'get', '--id', id, '--out', '--overwrite'], {})
    ).toThrow('Missing value for --out')
  })

  it('parses raw model input without allowing an ambiguous prompt source', () => {
    expect(
      parseCliArguments(
        [
          'model',
          'invoke',
          '--provider',
          'provider-1',
          '--model',
          'model-1',
          '--system',
          'Be concise',
          '--stdin',
          '--temperature=0.2',
          '--max-tokens',
          '256'
        ],
        {}
      )
    ).toMatchObject({
      operation: 'stream',
      readStdin: true,
      timeoutMs: 1_800_000,
      params: {
        providerId: 'provider-1',
        modelId: 'model-1',
        messages: [{ role: 'system', content: 'Be concise' }],
        temperature: 0.2,
        maxTokens: 256
      }
    })

    expect(() =>
      parseCliArguments(
        [
          'model',
          'invoke',
          '--provider',
          'provider-1',
          '--model',
          'model-1',
          '--prompt',
          'hello',
          '--stdin'
        ],
        {}
      )
    ).toThrow('exactly one of --prompt or --stdin')
  })

  it('keeps model flags after the two-token capability signature', () => {
    expect(() =>
      parseCliArguments(
        ['--json', 'model', 'invoke', '--provider', 'provider-1', '--model', 'model-1'],
        {}
      )
    ).toThrow('deepchat <domain> <verb>')
    expect(() => parseCliArguments(['provider', 'list', '--provider', 'provider-1'], {})).toThrow(
      'not valid for deepchat provider list'
    )
    expect(parseCliArguments(['provider', 'list', '--enabled-only'], {})).toMatchObject({
      params: { enabledOnly: true }
    })
  })
})
