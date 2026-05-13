// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CLI run command unit tests for credential injection and child process exit propagation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliConfig } from '../../../../apps/cli/src/config.js'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { runCommand } from '../../../../apps/cli/src/commands/run.js'

const cfg: CliConfig = {
  zone_url: 'https://sts.example.com',
  app_client_id: 'zone1:app1',
  app_client_secret: 'secret',
  credentials: [{ env: 'RESOURCE_TOKEN', resource: 'resource://api' }],
}

describe('runCommand', () => {
  let stderr = ''
  let stdout = ''

  beforeEach(() => {
    stderr = ''
    stdout = ''
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
  })

  it('injects exchanged credentials into child process env', async () => {
    let childEnv: Record<string, string> = {}
    spawnMock.mockImplementationOnce((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      childEnv = { ...opts.env }
      return {
        on: (event: string, handler: (code?: number, signal?: string) => void) => {
          if (event === 'exit') queueMicrotask(() => handler(0))
          return undefined
        },
      }
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'resource-token', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(runCommand(['node', 'tool.js'], cfg)).rejects.toThrow('exit:0')

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('ttl_seconds')).toBe('3600')
    expect(body.get('resource')).toBe('resource://api')
    expect(spawnMock).toHaveBeenCalledWith('node', ['tool.js'], expect.objectContaining({ stdio: 'inherit' }))
    expect(childEnv.RESOURCE_TOKEN).toBe('resource-token')
  })

  it('strips the pnpm separator before spawning the child command', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'resource-token', expires_in: 3600 }),
    }))

    await expect(runCommand(['--', 'node', 'tool.js'], cfg)).rejects.toThrow('exit:0')

    expect(spawnMock).toHaveBeenCalledWith('node', ['tool.js'], expect.objectContaining({ stdio: 'inherit' }))
  })

  it('warns for optional credential failures and still runs child command', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error_description: 'optional denied' }),
    }))

    await expect(runCommand(['node', 'tool.js'], {
      ...cfg,
      credentials: [],
      optional_credentials: [{ env: 'OPTIONAL_TOKEN', resource: 'resource://optional', on_failure: 'warn' }],
    })).rejects.toThrow('exit:0')

    expect(stdout).toContain('optional credential skipped resource=resource://optional reason=optional denied')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})