// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for run verb bodies: credential env building and safe spawning.

import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchRunCredentialMock = vi.hoisted(() => vi.fn())
const fetchRunManifestMock = vi.hoisted(() => vi.fn())
const pollStepUpStateMock = vi.hoisted(() => vi.fn())

vi.mock('@caracalai/oauth', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    fetchRunCredential: fetchRunCredentialMock,
    fetchRunManifest: fetchRunManifestMock,
    pollStepUpState: pollStepUpStateMock,
  }
})

import { buildRunEnv, resolveRunConfig, runExec } from '../../../../packages/engine/src/run.js'
import type { RunProfile } from '../../../../packages/engine/src/run.js'
import { ApprovalRequiredError } from '@caracalai/oauth'
import type { RunBinding } from '@caracalai/oauth'
import type { RuntimeIdentity } from '../../../../packages/engine/src/runtimeConfig.js'

const identity: RuntimeIdentity = {
  sts_url: 'http://localhost:8080',
  workload_id: 'wl1',
  workload_secret: 'ws_secret',
}

function binding(overrides: Partial<RunBinding> = {}): RunBinding {
  return { env: 'API_KEY', resource: 'urn:api', scopes: [], optional: false, onFailure: 'error', ...overrides }
}

function profile(bindings: RunBinding[]): RunProfile {
  return { identity, zoneId: 'z1', bindings, launchId: 'launch-1' }
}

afterEach(() => {
  fetchRunCredentialMock.mockReset()
  fetchRunManifestMock.mockReset()
  pollStepUpStateMock.mockReset()
  vi.restoreAllMocks()
})

describe('resolveRunConfig', () => {
  it('assembles the launch profile from the STS manifest', async () => {
    const bindings = [
      binding({ env: 'API_KEY', resource: 'urn:api', scopes: ['api:read'] }),
      binding({ env: 'OPT', resource: 'urn:opt', optional: true, onFailure: 'warn' }),
    ]
    fetchRunManifestMock.mockResolvedValue({ zoneId: 'z1', workloadId: 'wl1', bindings })
    const cfg = await resolveRunConfig(identity)
    expect(fetchRunManifestMock).toHaveBeenCalledWith('http://localhost:8080', 'wl1', 'ws_secret', { launchId: cfg.launchId })
    expect(cfg).toEqual({ identity, zoneId: 'z1', bindings, launchId: expect.any(String) })
  })

  it('rejects manifests with blocked or duplicate env names', async () => {
    fetchRunManifestMock.mockResolvedValue({
      zoneId: 'z1',
      workloadId: 'wl1',
      bindings: [binding({ env: 'LD_PRELOAD' })],
    })
    await expect(resolveRunConfig(identity)).rejects.toThrow(/blocked credential env/)
    fetchRunManifestMock.mockResolvedValue({
      zoneId: 'z1',
      workloadId: 'wl1',
      bindings: [binding({ env: 'DUP', resource: 'urn:a' }), binding({ env: 'DUP', resource: 'urn:b' })],
    })
    await expect(resolveRunConfig(identity)).rejects.toThrow(/duplicate credential env/)
  })
})

describe('buildRunEnv', () => {
  it('mints a credential for each binding', async () => {
    fetchRunCredentialMock.mockResolvedValue({ env: 'API_KEY', credential: 'tok-123' })
    const env = await buildRunEnv(profile([binding()]))
    expect(env.API_KEY).toBe('tok-123')
    expect(env.API_KEY_EXPIRES_AT).toBeUndefined()
    expect(fetchRunCredentialMock).toHaveBeenCalledWith('http://localhost:8080', 'wl1', 'ws_secret', 'API_KEY', {
      launchId: 'launch-1',
    })
  })

  it('injects the expiry companion variable when the mint reports one', async () => {
    fetchRunCredentialMock.mockResolvedValue({ env: 'API_KEY', credential: 'tok-123', expiresAt: 1750000000 })
    const env = await buildRunEnv(profile([binding()]))
    expect(env.API_KEY).toBe('tok-123')
    expect(env.API_KEY_EXPIRES_AT).toBe('1750000000')
  })

  it('lets an explicit binding claim the derived expiry name', async () => {
    fetchRunCredentialMock.mockImplementation(async (_url, _id, _secret, env: string) => ({
      env,
      credential: `tok-${env}`,
      expiresAt: 1750000000,
    }))
    const env = await buildRunEnv(profile([binding(), binding({ env: 'API_KEY_EXPIRES_AT', resource: 'urn:other' })]))
    expect(env.API_KEY).toBe('tok-API_KEY')
    expect(env.API_KEY_EXPIRES_AT).toBe('tok-API_KEY_EXPIRES_AT')
  })

  it('rejects invalid, blocked, and duplicate credential env names', async () => {
    fetchRunCredentialMock.mockResolvedValue({ env: 'X', credential: 'tok' })
    await expect(buildRunEnv(profile([binding({ env: '1bad' })]))).rejects.toThrow(/invalid_credential_env/)
    await expect(buildRunEnv(profile([binding({ env: 'LD_PRELOAD' })]))).rejects.toThrow(/blocked_credential_env/)
    await expect(buildRunEnv(profile([binding({ env: 'ld_preload' })]))).rejects.toThrow(/blocked_credential_env/)
    await expect(buildRunEnv(profile([binding({ env: 'DUP', resource: 'r1' }), binding({ env: 'DUP', resource: 'r2' })]))).rejects.toThrow(
      /duplicate_credential_env/,
    )
  })

  it('throws on a required credential failure', async () => {
    fetchRunCredentialMock.mockRejectedValue(new Error('mint failed'))
    const lines: string[] = []
    await expect(buildRunEnv(profile([binding({ resource: 'r' })]), { onLine: (l) => lines.push(l) })).rejects.toThrow('mint failed')
    expect(lines.some((l) => l.includes('"resource":"r"'))).toBe(true)
  })

  it('skips optional credentials that fail with on_failure warn', async () => {
    fetchRunCredentialMock.mockRejectedValue(new Error('nope'))
    const lines: string[] = []
    const env = await buildRunEnv(profile([binding({ env: 'OPT', resource: 'r', optional: true, onFailure: 'warn' })]), {
      onLine: (l) => lines.push(l),
    })
    expect(env.OPT).toBeUndefined()
    expect(lines.some((l) => l.includes('optional credential skipped'))).toBe(true)
  })

  it('throws when an optional credential with on_failure error fails', async () => {
    fetchRunCredentialMock.mockRejectedValue(new Error('nope'))
    await expect(buildRunEnv(profile([binding({ env: 'OPT', resource: 'r', optional: true, onFailure: 'error' })]))).rejects.toThrow('nope')
  })

  it('waits for an approval and retries the mint with the challenge id', async () => {
    fetchRunCredentialMock
      .mockRejectedValueOnce(new ApprovalRequiredError('approval required', 'chal-1', { binding: 'aa' }))
      .mockResolvedValueOnce({ env: 'API_KEY', credential: 'after-approval' })
    pollStepUpStateMock.mockResolvedValue('approved')
    const lines: string[] = []
    const env = await buildRunEnv(profile([binding({ resource: 'r' })]), { onLine: (l) => lines.push(l) })
    expect(env.API_KEY).toBe('after-approval')
    expect(lines.some((l) => l.includes('approval_required') && l.includes('chal-1') && l.includes('"binding":"aa"'))).toBe(true)
    expect(pollStepUpStateMock).toHaveBeenCalledWith('http://localhost:8080', 'chal-1', { timeoutMs: 300_000 })
    expect(fetchRunCredentialMock).toHaveBeenLastCalledWith('http://localhost:8080', 'wl1', 'ws_secret', 'API_KEY', {
      challengeId: 'chal-1',
      launchId: 'launch-1',
    })
  })

  it('bounds the wait window by the hold expiry', async () => {
    fetchRunCredentialMock
      .mockRejectedValueOnce(
        new ApprovalRequiredError('approval required', 'chal-1', {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce({ env: 'API_KEY', credential: 'after-approval' })
    pollStepUpStateMock.mockResolvedValue('approved')
    await buildRunEnv(profile([binding({ resource: 'r' })]))
    const timeoutMs = pollStepUpStateMock.mock.calls[0][2].timeoutMs as number
    expect(timeoutMs).toBeGreaterThan(50_000)
    expect(timeoutMs).toBeLessThanOrEqual(60_000)
  })

  it('fails the credential when the approval is rejected', async () => {
    fetchRunCredentialMock.mockRejectedValue(new ApprovalRequiredError('approval required', 'chal-1', {}))
    pollStepUpStateMock.mockResolvedValue('rejected')
    await expect(buildRunEnv(profile([binding({ resource: 'r' })]))).rejects.toThrow('approval_rejected')
    expect(fetchRunCredentialMock).toHaveBeenCalledTimes(1)
  })
})

describe('runExec', () => {
  it('rejects empty argv and NUL bytes', () => {
    expect(() => runExec({ argv: [] })).toThrow(/argv is empty/)
    expect(() => runExec({ argv: ['node', 'a\u0000b'] })).toThrow(/NUL byte/)
  })

  it('rejects invalid child env keys', () => {
    expect(() => runExec({ argv: ['true'], env: { '1bad': 'x' }, forwardSignals: false })).toThrow(/invalid_child_env/)
    expect(() => runExec({ argv: ['true'], env: { LD_PRELOAD: 'x' }, forwardSignals: false })).toThrow(/blocked_child_env/)
    expect(() => runExec({ argv: ['true'], env: { ld_preload: 'x' }, forwardSignals: false })).toThrow(/blocked_child_env/)
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
