// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CLI init command unit tests for bootstrap config writing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initCommand } from '../../../../apps/cli/src/commands/init.js'

describe('initCommand', () => {
  let dir = ''
  let stdout = ''
  let stderr = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-init-'))
    stdout = ''
    stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString()
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes local config with client secret from bootstrap response', async () => {
    const configPath = join(dir, 'caracal.toml')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        zone_id: 'zone1',
        app_id: 'app1',
        app_client_id: 'zone1:app1',
        app_client_secret: 'secret-1',
        resource: 'resource://example',
        scope: 'read agent:lifecycle',
        rotated: false,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await initCommand([
      '--api-url', 'http://api.local',
      '--zone-url', 'http://sts.local',
      '--admin-token', 'admin-secret',
      '--config', configPath,
    ])

    const body = readFileSync(configPath, 'utf8')
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.local/v1/local/bootstrap')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer admin-secret')
    expect(body).toContain('zone_url = "http://sts.local"')
    expect(body).toContain('app_client_secret = "secret-1"')
    expect(body).toContain('resource = "resource://example"')
    expect((statSync(configPath).mode & 0o777).toString(8)).toBe('600')
    expect(stdout).toContain(`Wrote ${configPath}`)
  })

  it('updates an existing cwd config when no config flag is provided', async () => {
    const configPath = join(dir, 'caracal.toml')
    writeFileSync(configPath, 'zone_url = "http://stale"\napp_client_id = "zone1:app1"\napp_client_secret = "stale"\n')
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    vi.stubEnv('PWD', dir)
    vi.stubEnv('INIT_CWD', dir)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        zone_id: 'zone1',
        app_id: 'app1',
        app_client_id: 'zone1:app1',
        app_client_secret: 'secret-2',
        resource: 'resource://example',
        scope: 'read agent:lifecycle',
        rotated: true,
      }),
    }))

    await initCommand(['--admin-token', 'admin-secret'])

    const body = readFileSync(configPath, 'utf8')
    expect(body).toContain('app_client_secret = "secret-2"')
    expect(stdout).toContain(`Wrote ${configPath}`)
  })

  it('fails when bootstrap returns no secret and no config exists', async () => {
    const configPath = join(dir, 'missing.toml')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        zone_id: 'zone1',
        app_id: 'app1',
        app_client_id: 'zone1:app1',
        app_client_secret: null,
        resource: 'resource://example',
        scope: 'read agent:lifecycle',
        rotated: false,
      }),
    }))

    await expect(initCommand(['--admin-token', 'admin-secret', '--config', configPath])).rejects.toThrow('exit:1')

    expect(stderr).toContain('re-run with --force')
  })

  it('writes caracal.toml atomically without leaving .tmp siblings', async () => {
    const configPath = join(dir, 'caracal.toml')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        zone_id: 'zone1',
        app_id: 'app1',
        app_client_id: 'zone1:app1',
        app_client_secret: 'secret-3',
        resource: 'resource://example',
        scope: 'read agent:lifecycle',
        rotated: false,
      }),
    }))

    await initCommand([
      '--api-url', 'http://api.local',
      '--zone-url', 'http://sts.local',
      '--admin-token', 'admin-secret',
      '--config', configPath,
    ])

    const { readdirSync } = await import('node:fs')
    const siblings = readdirSync(dir)
    expect(siblings).toContain('caracal.toml')
    expect(siblings.filter((f: string) => f.startsWith('caracal.toml.tmp-'))).toEqual([])
  })
})