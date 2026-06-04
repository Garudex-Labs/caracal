// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Engine admin bootstrap discovers local coordinator tokens for Console views.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildAdminClient, readContent } from '../../../../packages/engine/src/shared.ts'

describe('buildAdminClient', () => {
  const saved = { ...process.env }
  let dir: string

  function setAdminlessEnv(env: NodeJS.ProcessEnv): void {
    process.env = { ...saved, ...env }
    delete process.env.CARACAL_ADMIN_TOKEN
    delete process.env.CARACAL_ADMIN_TOKEN_FILE
    delete process.env.CARACAL_COORDINATOR_TOKEN
    delete process.env.CARACAL_COORDINATOR_TOKEN_FILE
    delete process.env.CARACAL_DEV_SECRETS_DIR
    delete process.env.CARACAL_ENV_FILE
    delete process.env.CARACAL_SECRETS_DIR
    delete process.env.CARACAL_ALLOW_WORKSPACE_SECRETS
  }

  afterEach(() => {
    process.env = { ...saved }
    vi.unstubAllGlobals()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('recommends pnpm caracal up when the admin token is missing in dev mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-shared-'))
    setAdminlessEnv({
      CARACAL_HOME: dir,
      CARACAL_MODE: 'dev',
      CARACAL_API_URL: 'http://localhost:3000',
      CARACAL_COORDINATOR_URL: 'http://localhost:4000',
    })

    expect(() => buildAdminClient()).toThrow(
      'Admin token not found; run `pnpm caracal up` to provision local admin credentials.',
    )
  })

  it('recommends pnpm caracal up when launched from the workspace', () => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-shared-'))
    setAdminlessEnv({
      CARACAL_HOME: dir,
      CARACAL_REPO_ROOT: dir,
      CARACAL_API_URL: 'http://localhost:3000',
      CARACAL_COORDINATOR_URL: 'http://localhost:4000',
    })
    delete process.env.CARACAL_MODE

    expect(() => buildAdminClient()).toThrow(
      'Admin token not found; run `pnpm caracal up` to provision local admin credentials.',
    )
  })

  it.each(['rc', 'stable'] as const)('recommends caracal up when the admin token is missing in %s mode', (mode) => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-shared-'))
    setAdminlessEnv({
      CARACAL_HOME: dir,
      CARACAL_MODE: mode,
      CARACAL_REPO_ROOT: dir,
      CARACAL_API_URL: 'http://localhost:3000',
      CARACAL_COORDINATOR_URL: 'http://localhost:4000',
    })

    expect(() => buildAdminClient()).toThrow(
      'Admin token not found; run `caracal up` to provision local admin credentials.',
    )
  })

  it('discovers the coordinator token from the local secret file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-shared-'))
    const tokenFile = join(dir, 'coordinator-token')
    writeFileSync(tokenFile, 'coordinator-secret\n')
    process.env = {
      ...saved,
      CARACAL_ADMIN_TOKEN: 'admin-secret',
      CARACAL_API_URL: 'http://api.test',
      CARACAL_COORDINATOR_TOKEN_FILE: tokenFile,
      CARACAL_COORDINATOR_URL: 'http://coordinator.test',
    }
    delete process.env.CARACAL_COORDINATOR_TOKEN
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], next_cursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { client } = buildAdminClient()
    await client.agents.list('z1')

    expect(fetchMock).toHaveBeenCalledWith('http://coordinator.test/zones/z1/agents', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer coordinator-secret' }),
    }))
  })

  it('uses generated local coordinator secrets instead of stale env tokens for local Console', async () => {
    dir = mkdtempSync(join(tmpdir(), 'caracal-shared-'))
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'caracalAdminToken'), 'admin-secret\n')
    writeFileSync(join(dir, 'secrets', 'caracalCoordinatorToken'), 'coordinator-secret\n')
    mkdirSync(join(dir, 'infra', 'secrets', 'files'), { recursive: true })
    writeFileSync(join(dir, 'infra', 'secrets', 'files', 'caracalAdminToken'), 'dev-admin-secret\n')
    writeFileSync(join(dir, 'infra', 'secrets', 'files', 'caracalCoordinatorToken'), 'dev-coordinator-secret\n')
    process.env = {
      ...saved,
      CARACAL_HOME: dir,
      CARACAL_REPO_ROOT: dir,
      CARACAL_ADMIN_TOKEN: 'stale-admin',
      CARACAL_COORDINATOR_TOKEN: 'stale-coordinator',
      CARACAL_API_URL: 'http://localhost:3000',
      CARACAL_COORDINATOR_URL: 'http://localhost:4000',
    }
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return new Response(JSON.stringify(url.includes('/agents') ? { items: [], next_cursor: null } : []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { client } = buildAdminClient()
    await client.zones.list()
    await client.agents.list('z1')

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/v1/zones', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer admin-secret' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/zones/z1/agents', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer coordinator-secret' }),
    }))
  })
})

describe('readContent', () => {
  it('rejects missing content and reads @file references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-read-content-'))
    try {
      const file = join(dir, 'policy.rego')
      writeFileSync(file, 'package caracal\n', 'utf8')

      expect(() => readContent(undefined)).toThrow('missing content')
      expect(readContent('@' + file)).toBe('package caracal\n')
      expect(readContent('inline policy')).toBe('inline policy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
