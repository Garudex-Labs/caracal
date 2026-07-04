// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime run command unit tests for credential injection and child process exit propagation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeIdentity } from '../../../../apps/runtime/src/config.js'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { runCommand } from '../../../../apps/runtime/src/commands/run.js'

const cfg: RuntimeIdentity = {
  sts_url: 'https://sts.example.com',
  application_id: 'app1',
  app_client_secret: 'secret',
}

function manifestResponse(credentials: unknown[]): Record<string, unknown> {
  return { zone_id: 'zone1', application_id: 'app1', credentials }
}

function stubRunFetch(
  manifest: Record<string, unknown>,
  exchange: { ok: boolean; status?: number; body: unknown } = { ok: true, body: {} },
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes('/v1/run/manifest')) {
      return { ok: true, status: 200, json: async () => manifest }
    }
    return {
      ok: exchange.ok,
      status: exchange.status ?? 200,
      json: async () => exchange.body,
      text: async () => JSON.stringify(exchange.body),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('runCommand', () => {
  let stderr = ''
  let stdout = ''
  let runAllow: string | undefined

  beforeEach(() => {
    stderr = ''
    stdout = ''
    runAllow = process.env.CARACAL_RUN_ALLOW_WORKSPACE_SECRETS
    process.env.CARACAL_RUN_ALLOW_WORKSPACE_SECRETS = 'true'
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`)
    })
    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown) => ({
      on: (event: string, handler: (code?: number, signal?: string) => void) => {
        if (event === 'exit') queueMicrotask(() => handler(0))
        return undefined
      },
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    spawnMock.mockReset()
    if (runAllow === undefined) delete process.env.CARACAL_RUN_ALLOW_WORKSPACE_SECRETS
    else process.env.CARACAL_RUN_ALLOW_WORKSPACE_SECRETS = runAllow
  })

  it('injects exchanged credentials into child process env', async () => {
    let childEnv: Record<string, string> = {}
    const originalAdminToken = process.env.CARACAL_ADMIN_TOKEN
    const originalDockerHost = process.env.DOCKER_HOST
    const originalPath = process.env.PATH
    process.env.CARACAL_ADMIN_TOKEN = 'admin-token'
    process.env.DOCKER_HOST = 'unix:///var/run/docker.sock'
    process.env.PATH = '/usr/bin'
    try {
      spawnMock.mockImplementationOnce((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        childEnv = { ...opts.env }
        return {
          on: (event: string, handler: (code?: number, signal?: string) => void) => {
            if (event === 'exit') queueMicrotask(() => handler(0))
            return undefined
          },
        }
      })
      const fetchMock = stubRunFetch(manifestResponse([{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }]), {
        ok: true,
        body: {
          access_token: 'caracal-mandate',
          expires_in: 900,
          upstreams: { 'resource://api': { provider_token: 'resource-token' } },
        },
      })

      await expect(runCommand(['node', 'tool.js'], cfg)).rejects.toThrow('exit:0')

      const manifestBody = fetchMock.mock.calls[0][1].body as URLSearchParams
      expect(manifestBody.get('application_id')).toBe('app1')
      const body = fetchMock.mock.calls[1][1].body as URLSearchParams
      expect(body.get('ttl_seconds')).toBe('900')
      expect(body.get('resource')).toBe('resource://api')
      expect(body.get('runtime_credential_injection')).toBe('true')
      expect(spawnMock).toHaveBeenCalledWith('node', ['tool.js'], expect.objectContaining({ stdio: 'inherit' }))
      expect(childEnv.RESOURCE_TOKEN).toBe('resource-token')
      expect(childEnv.CARACAL_ADMIN_TOKEN).toBeUndefined()
      expect(childEnv.DOCKER_HOST).toBeUndefined()
      expect(childEnv.PATH).toBe('/usr/bin')
    } finally {
      if (originalAdminToken === undefined) delete process.env.CARACAL_ADMIN_TOKEN
      else process.env.CARACAL_ADMIN_TOKEN = originalAdminToken
      if (originalDockerHost === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = originalDockerHost
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it('strips the pnpm separator before spawning the child command', async () => {
    stubRunFetch(manifestResponse([{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }]), {
      ok: true,
      body: {
        access_token: 'caracal-mandate',
        expires_in: 900,
        upstreams: { 'resource://api': { provider_token: 'resource-token' } },
      },
    })

    await expect(runCommand(['--', 'node', 'tool.js'], cfg)).rejects.toThrow('exit:0')

    expect(spawnMock).toHaveBeenCalledWith('node', ['tool.js'], expect.objectContaining({ stdio: 'inherit' }))
  })

  it('reports child process spawn errors before returning command-not-found', async () => {
    stubRunFetch(manifestResponse([{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }]), {
      ok: true,
      body: {
        access_token: 'caracal-mandate',
        expires_in: 900,
        upstreams: { 'resource://api': { provider_token: 'resource-token' } },
      },
    })
    spawnMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown) => ({
      on: (event: string, handler: (err?: Error) => void) => {
        if (event === 'error') {
          const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
          queueMicrotask(() => handler(err))
        }
        return undefined
      },
    }))

    await expect(runCommand(['docker', 'compose', 'down'], cfg)).rejects.toThrow('exit:127')

    expect(stderr).toContain('failed to start docker: spawn docker ENOENT (ENOENT)')
  })

  it('warns for optional credential failures and still runs child command', async () => {
    stubRunFetch(
      manifestResponse([{ env: 'OPTIONAL_TOKEN', resource: 'resource://optional', optional: true, on_failure: 'warn' }]),
      { ok: false, status: 403, body: { error_description: 'optional denied' } },
    )

    await expect(runCommand(['node', 'tool.js'], cfg)).rejects.toThrow('exit:0')

    expect(stdout).toContain('optional credential skipped resource=resource://optional reason=optional denied')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('fails when optional credential policy requires success', async () => {
    stubRunFetch(
      manifestResponse([{ env: 'OPTIONAL_TOKEN', resource: 'resource://optional', optional: true, on_failure: 'error' }]),
      { ok: false, status: 403, body: { error_description: 'optional denied' } },
    )

    await expect(runCommand(['node', 'tool.js'], cfg)).rejects.toThrow('exit:1')

    expect(stderr).toContain('"resource":"resource://optional"')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects dangerous credential environment names before token exchange', async () => {
    const fetchMock = stubRunFetch(manifestResponse([{ env: 'NODE_OPTIONS', resource: 'resource://api' }]))

    await expect(runCommand(['node', 'tool.js'], cfg)).rejects.toThrow('exit:1')

    expect(stderr).toContain("blocked credential env 'NODE_OPTIONS'")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('blocks workloads when workspace operator secrets are present', async () => {
    const cwd = process.cwd()
    const repo = mkdtempSync(join(tmpdir(), 'caracal-run-repo-'))
    try {
      delete process.env.CARACAL_RUN_ALLOW_WORKSPACE_SECRETS
      writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages: []\n')
      writeFileSync(join(repo, 'package.json'), '{"private":true}\n')
      mkdirSync(join(repo, 'infra', 'secrets', 'files'), { recursive: true })
      writeFileSync(join(repo, 'infra', 'secrets', 'files', 'caracalAdminToken'), 'admin\n')
      process.chdir(repo)
      vi.stubGlobal('fetch', vi.fn())

      await expect(runCommand(['node', 'tool.js'], cfg)).rejects.toThrow('exit:1')

      expect(stderr).toContain('refusing to run workload while workspace operator secrets are present')
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      process.chdir(cwd)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('prints help and exits 0 for a help request without spawning a child', async () => {
    for (const token of ['help', '--help', '-h']) {
      stdout = ''
      await expect(runCommand([token])).rejects.toThrow('exit:0')
      expect(stdout).toContain('Usage: caracal run')
      expect(stdout).toContain('Examples:')
    }
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prints usage and exits 1 when no command is given', async () => {
    await expect(runCommand([])).rejects.toThrow('exit:1')
    expect(stderr).toContain('Usage: caracal run')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('exits 1 with a clear message when config is missing for a real command', async () => {
    await expect(runCommand(['node', 'tool.js'], undefined)).rejects.toThrow('exit:1')
    expect(stderr).toContain('workload identity is required to run a command')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('runs a literal command after the -- separator instead of treating it as help', async () => {
    stubRunFetch(manifestResponse([{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }]), {
      ok: true,
      body: {
        access_token: 'caracal-mandate',
        expires_in: 900,
        upstreams: { 'resource://api': { provider_token: 'resource-token' } },
      },
    })

    await expect(runCommand(['--', 'help'], cfg)).rejects.toThrow('exit:0')

    expect(spawnMock).toHaveBeenCalledWith('help', [], expect.objectContaining({ stdio: 'inherit' }))
  })
})
