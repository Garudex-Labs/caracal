// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for run verb bodies: MCP governance, credential env building, and safe spawning.

import { afterEach, describe, expect, it, vi } from 'vitest'

const exchangeMock = vi.fn()

vi.mock('@caracalai/oauth', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    OAuthClient: class {
      exchange = exchangeMock
    },
  }
})

import { checkMcpGovernance, buildRunEnv, runExec } from '../../../../packages/engine/src/run.js'
import { InteractionRequiredError } from '@caracalai/oauth'
import type { RuntimeConfig } from '../../../../packages/engine/src/runtimeConfig.js'

const baseConfig: RuntimeConfig = {
  zone_url: 'http://localhost:8080',
  zone_id: 'z1',
  application_id: 'app1',
  app_client_secret: 'secret',
} as unknown as RuntimeConfig

afterEach(() => {
  exchangeMock.mockReset()
  vi.restoreAllMocks()
})

describe('checkMcpGovernance', () => {
  it('does nothing for ordinary commands', () => {
    const lines: string[] = []
    expect(() => checkMcpGovernance(['node', 'app.js'], baseConfig, (l) => lines.push(l))).not.toThrow()
    expect(lines).toHaveLength(0)
  })

  it('blocks unauthorized MCP servers by default', () => {
    const lines: string[] = []
    expect(() => checkMcpGovernance('npx @modelcontextprotocol/server', baseConfig, (l) => lines.push(l))).toThrow(
      'mcp_governance_blocked',
    )
    expect(lines[0]).toContain('"action":"blocked"')
  })

  it('logs but allows when governance mode is log', () => {
    const lines: string[] = []
    expect(() =>
      checkMcpGovernance('python -m fastmcp', { ...baseConfig, mcp_governance: { mode: 'log' } }, (l) => lines.push(l)),
    ).not.toThrow()
    expect(lines[0]).toContain('"action":"log"')
  })
})

describe('buildRunEnv', () => {
  it('exchanges tokens for each credential', async () => {
    exchangeMock.mockResolvedValue({ accessToken: 'mandate', upstreams: { 'urn:api': { providerToken: 'tok-123' } } })
    const env = await buildRunEnv({ ...baseConfig, credentials: [{ env: 'API_KEY', resource: 'urn:api' }] })
    expect(env.API_KEY).toBe('tok-123')
    expect(exchangeMock).toHaveBeenCalledWith('', 'urn:api', {
      clientSecret: 'secret',
      ttlSeconds: 900,
      runtimeCredentialInjection: true,
    })
  })

  it('can inject a Caracal mandate for mandate-aware workloads', async () => {
    exchangeMock.mockResolvedValue({ accessToken: 'mandate-token' })
    const env = await buildRunEnv({
      ...baseConfig,
      credentials: [{ env: 'CARACAL_TOKEN', resource: 'urn:api', credential_type: 'caracal_mandate' }],
      ttl_seconds: 300,
    })
    expect(env.CARACAL_TOKEN).toBe('mandate-token')
    expect(exchangeMock).toHaveBeenCalledWith('', 'urn:api', {
      clientSecret: 'secret',
      ttlSeconds: 300,
      runtimeCredentialInjection: false,
    })
  })

  it('fails when provider-token injection is unavailable', async () => {
    exchangeMock.mockResolvedValue({ accessToken: 'mandate' })
    await expect(buildRunEnv({ ...baseConfig, credentials: [{ env: 'API_KEY', resource: 'urn:api' }] })).rejects.toThrow(
      'provider_credential_unavailable:urn:api',
    )
  })

  it('rejects invalid, blocked, and duplicate credential env names', async () => {
    exchangeMock.mockResolvedValue({ accessToken: 'tok' })
    await expect(buildRunEnv({ ...baseConfig, credentials: [{ env: '1bad', resource: 'r' }] })).rejects.toThrow(
      /invalid_credential_env/,
    )
    await expect(buildRunEnv({ ...baseConfig, credentials: [{ env: 'LD_PRELOAD', resource: 'r' }] })).rejects.toThrow(
      /blocked_credential_env/,
    )
    await expect(
      buildRunEnv({
        ...baseConfig,
        credentials: [
          { env: 'DUP', resource: 'r1' },
          { env: 'DUP', resource: 'r2' },
        ],
      }),
    ).rejects.toThrow(/duplicate_credential_env/)
  })

  it('continues past a failed credential when continue_on_failure is set', async () => {
    exchangeMock.mockRejectedValue(new Error('exchange failed'))
    const lines: string[] = []
    const env = await buildRunEnv(
      { ...baseConfig, continue_on_failure: true, credentials: [{ env: 'API_KEY', resource: 'r' }] },
      { onLine: (l) => lines.push(l) },
    )
    expect(env.API_KEY).toBeUndefined()
    expect(lines.some((l) => l.includes('"resource":"r"'))).toBe(true)
  })

  it('throws on a required credential failure without continue_on_failure', async () => {
    exchangeMock.mockRejectedValue(new Error('exchange failed'))
    await expect(buildRunEnv({ ...baseConfig, credentials: [{ env: 'API_KEY', resource: 'r' }] })).rejects.toThrow(
      'exchange failed',
    )
  })

  it('skips optional credentials that fail with on_failure warn', async () => {
    exchangeMock.mockRejectedValue(new Error('nope'))
    const lines: string[] = []
    const env = await buildRunEnv(
      { ...baseConfig, optional_credentials: [{ env: 'OPT', resource: 'r', on_failure: 'warn' }] },
      { onLine: (l) => lines.push(l) },
    )
    expect(env.OPT).toBeUndefined()
    expect(lines.some((l) => l.includes('optional credential skipped'))).toBe(true)
  })

  it('throws when an optional credential with on_failure error fails', async () => {
    exchangeMock.mockRejectedValue(new Error('nope'))
    await expect(
      buildRunEnv({ ...baseConfig, optional_credentials: [{ env: 'OPT', resource: 'r', on_failure: 'error' }] }),
    ).rejects.toThrow('nope')
  })

  it('completes a step-up challenge and retries the exchange', async () => {
    exchangeMock
      .mockRejectedValueOnce(new InteractionRequiredError('step up', 'chal-1', 'r'))
      .mockResolvedValueOnce({ accessToken: 'mandate', upstreams: { r: { providerToken: 'after-stepup' } } })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ satisfied: true }) } as unknown as Response)
    const lines: string[] = []
    const env = await buildRunEnv(
      { ...baseConfig, credentials: [{ env: 'API_KEY', resource: 'r' }] },
      { onLine: (l) => lines.push(l) },
    )
    expect(env.API_KEY).toBe('after-stepup')
    expect(lines.some((l) => l.includes('step_up_required'))).toBe(true)
    fetchSpy.mockRestore()
  })
})

describe('runExec', () => {
  it('rejects empty argv and NUL bytes', () => {
    expect(() => runExec({ argv: [] })).toThrow(/argv is empty/)
    expect(() => runExec({ argv: ['node', 'a\u0000b'] })).toThrow(/NUL byte/)
  })

  it('rejects invalid child env keys', () => {
    expect(() => runExec({ argv: ['true'], env: { '1bad': 'x' }, forwardSignals: false })).toThrow(/invalid_child_env/)
    expect(() => runExec({ argv: ['true'], env: { LD_PRELOAD: 'x' }, forwardSignals: false })).toThrow(
      /blocked_child_env/,
    )
  })

  it('captures output and resolves the exit code', async () => {
    const lines: string[] = []
    const handle = runExec({
      argv: [process.execPath, '-e', "process.stdout.write('hello\\n')"],
      onLine: (l, stream) => lines.push(`${stream}:${l}`),
      forwardSignals: false,
    })
    const code = await handle.exitCode
    expect(code).toBe(0)
    expect(lines).toContain('stdout:hello')
    handle.dispose()
  })

  it('resolves 127 when the command cannot be spawned', async () => {
    const lines: string[] = []
    const handle = runExec({
      argv: ['definitely-not-a-real-command-xyz'],
      onLine: (l) => lines.push(l),
      forwardSignals: false,
    })
    const code = await handle.exitCode
    expect(code).toBe(127)
    expect(lines.some((l) => l.includes('failed to start'))).toBe(true)
  })
})
