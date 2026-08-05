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
})
