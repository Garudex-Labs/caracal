// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// End-to-end CLI command tests using a stubbed fetch and admin token env.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditCommand, explainCommand } from '../../../../apps/cli/src/commands/audit.ts'
import { zoneCommand } from '../../../../apps/cli/src/commands/zone.ts'
import { agentCommand } from '../../../../apps/cli/src/commands/agent.ts'

const ORIG_ENV = { ...process.env }

function stubFetch(handler: (url: string, init: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const body = handler(url, init)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
      json: async () => body,
    }
  })
  vi.stubGlobal('fetch', f)
  return f
}

describe('CLI commands (e2e against stubbed fetch)', () => {
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>
  let exit: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env = { ...ORIG_ENV, CARACAL_ADMIN_TOKEN: 'secret', CARACAL_API_URL: 'http://api', CARACAL_COORDINATOR_URL: 'http://coordinator', CARACAL_ZONE_ID: 'z1' }
    delete process.env.CARACAL_COORDINATOR_TOKEN
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`__exit:${c ?? 0}`) }) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    process.env = { ...ORIG_ENV }
  })

  it('audit tail calls /v1/zones/:id/audit with filters and prints a table', async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe('http://api/v1/zones/z1/audit?decision=deny&limit=2')
      return [
        { id: 'a1', occurred_at: '2026-01-01T00:00:00Z', event_type: 'token.exchange', decision: 'deny', evaluation_status: 'evaluated', request_id: 'r1' },
        { id: 'a2', occurred_at: '2026-01-01T00:00:01Z', event_type: 'token.exchange', decision: 'deny', evaluation_status: 'evaluated', request_id: 'r2' },
      ]
    })
    await auditCommand(['tail', '--decision', 'deny', '--limit', '2'])
    expect(fetchMock).toHaveBeenCalledOnce()
    const written = stdout.mock.calls.map((c) => c[0]).join('')
    expect(written).toContain('event_type')
    expect(written).toContain('a1')
    expect(written).toContain('a2')
    expect(exit).not.toHaveBeenCalled()
  })

  it('audit tail --json emits machine-readable output', async () => {
    stubFetch(() => [{ id: 'a1', occurred_at: 't', event_type: 'e', decision: 'allow', evaluation_status: 'evaluated', request_id: 'r' }])
    await auditCommand(['tail', '--json'])
    const written = stdout.mock.calls.map((c) => c[0]).join('')
    expect(JSON.parse(written)).toEqual([
      { id: 'a1', occurred_at: 't', event_type: 'e', decision: 'allow', evaluation_status: 'evaluated', request_id: 'r' },
    ])
  })

  it('explain prints determining policies and diagnostics', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://api/v1/zones/z1/audit/by-request/req-7')
      return [{
        id: 'a9',
        event_type: 'token.exchange',
        decision: 'deny',
        evaluation_status: 'evaluated',
        occurred_at: '2026-01-01T00:00:00Z',
        request_id: 'req-7',
        policy_set_id: 'ps-1',
        policy_set_version_id: 'psv-2',
        manifest_sha: 'sha-3',
        determining_policies_json: [{ policy_id: 'p1', effect: 'deny' }],
        diagnostics_json: [{ rule: 'mfa_required' }],
        metadata_json: { user_agent: 'curl' },
      }]
    })
    await explainCommand(['req-7'])
    const out = stdout.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('determining_policies')
    expect(out).toContain('mfa_required')
    expect(out).toContain('user_agent')
  })

  it('explain requires a request id', async () => {
    await expect(explainCommand([])).rejects.toThrow(/__exit:1/)
    expect(stderr).toHaveBeenCalled()
  })

  it('zone list pretty-prints a table', async () => {
    stubFetch(() => [{ id: 'z1', slug: 'demo', display_name: 'Demo', status: 'active', created_at: 't' }])
    await zoneCommand(['list'])
    const out = stdout.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('id')
    expect(out).toContain('z1')
  })

  it('agent list refuses to run without coordinator token', async () => {
    await expect(agentCommand(['list'])).rejects.toThrow(/__exit:1/)
    expect(stderr.mock.calls.map((c) => c[0]).join('')).toContain('CARACAL_COORDINATOR_TOKEN')
  })

  it('audit command exits 1 when CARACAL_ADMIN_TOKEN is missing', async () => {
    const cwd = process.cwd()
    process.chdir(mkdtempSync(join(tmpdir(), 'caracal-empty-cwd-')))
    delete process.env.CARACAL_ADMIN_TOKEN
    try {
      await expect(auditCommand(['tail'])).rejects.toThrow(/__exit:1/)
      expect(stderr.mock.calls.map((c) => c[0]).join('')).toContain('CARACAL_ADMIN_TOKEN')
    } finally {
      process.chdir(cwd)
    }
  })
})
