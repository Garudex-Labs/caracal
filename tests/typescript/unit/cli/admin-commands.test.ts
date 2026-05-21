// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// End-to-end CLI command tests using a stubbed fetch and admin token env.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditCommand, explainCommand } from '../../../../apps/cli/src/commands/audit.ts'
import { zoneCommand } from '../../../../apps/cli/src/commands/zone.ts'
import { agentCommand, delegationCommand } from '../../../../apps/cli/src/commands/agent.ts'
import { policyCommand, policySetCommand } from '../../../../apps/cli/src/commands/policy.ts'
import { doctorCommand } from '../../../../apps/cli/src/commands/doctor.ts'
import { manifestCommand } from '../../../../apps/cli/src/commands/manifest.ts'
import { protectCommand } from '../../../../apps/cli/src/commands/protect.ts'

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
    process.env = { ...ORIG_ENV, CARACAL_ADMIN_TOKEN: 'secret', CARACAL_API_URL: 'http://api', CARACAL_COORDINATOR_URL: 'http://coordinator', CARACAL_STS_URL: 'http://sts', CARACAL_ZONE_ID: 'z1' }
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
        metadata_json: {
          user_agent: 'curl',
          application_id: 'app-1',
          session_id: 'sid-1',
          agent_session_id: 'agent-1',
          delegation_edge_id: 'edge-1',
          resource: 'resource://calendar',
          requested_scopes: ['calendar:read'],
          provider_id: 'provider-1',
          grant_id: 'grant-1',
          auth_mode: 'provider_oauth',
        },
      }]
    })
    await explainCommand(['req-7'])
    const out = stdout.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('determining_policies')
    expect(out).toContain('mfa_required')
    expect(out).toContain('authority:')
    expect(out).toContain('authority_session      sid-1')
    expect(out).toContain('provider               provider-1 grant=grant-1 auth=provider_oauth')
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

  it('delegation help prints delegation commands', async () => {
    process.env.CARACAL_COORDINATOR_TOKEN = 'coordinator-token'
    await expect(delegationCommand(['help'])).rejects.toThrow(/__exit:0/)
    const out = stdout.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('Usage: caracal delegation')
    expect(out).toContain('inbound <session-id>')
    expect(out).not.toContain('Usage: caracal agent')
  })

  it('policy template list prints built-in templates', async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe('http://api/v1/policy-templates')
      return [{ id: 'baseline-scopes', name: 'Baseline Scopes', description: 'Scope checks', content: 'package caracal.authz\nresult := {}' }]
    })
    await policyCommand(['template', 'list'])
    expect(fetchMock).toHaveBeenCalledOnce()
    const out = stdout.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('baseline-scopes')
    expect(out).toContain('Scope checks')
  })

  it('policy sample-input prints a local fixture without admin API access', async () => {
    delete process.env.CARACAL_ADMIN_TOKEN

    await policyCommand(['sample-input', '--resource', 'resource://calendar', '--scopes', 'calendar:read,calendar:write', '--principal', 'user-1', '--zone', 'zone-1'])

    const body = JSON.parse(stdout.mock.calls.map((c) => c[0]).join(''))
    expect(body).toMatchObject({
      schema_version: '2026-05-20',
      principal: { id: 'user-1', zone_id: 'zone-1' },
      resource: { identifier: 'resource://calendar', scopes: ['calendar:read', 'calendar:write'] },
      action: { id: 'calendar:read' },
      context: { requested_scopes: ['calendar:read', 'calendar:write'] },
    })
  })

  it('policy validate posts Rego to the validation endpoint', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://api/v1/policies/validate')
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({
        content: 'package caracal.authz\nresult := {}',
        schema_version: '2026-05-20',
      })
      return {
        valid: true,
        schema_version: '2026-05-20',
        input_schema_version: '2026-05-20',
        output_contract: { package: 'caracal.authz', rule: 'result', decision: ['allow', 'deny'], evaluation_status: ['complete'] },
        warnings: [],
      }
    })

    await policyCommand(['validate', '--content', 'package caracal.authz\nresult := {}', '--schema-version', '2026-05-20'])

    expect(JSON.parse(stdout.mock.calls.map((c) => c[0]).join(''))).toMatchObject({ valid: true })
  })

  it('manifest validate accepts Gateway upstream manifests offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-manifest-'))
    const file = join(dir, 'gateway.json')
    writeFileSync(file, JSON.stringify({
      schema_version: '2026-05-21',
      name: 'calendar-api',
      version: '1.0.0',
      resource_identifier: 'resource://calendar',
      protocols: ['http/1.1'],
      auth_modes: ['caracal_jwt'],
      scopes: ['calendar:read'],
      identity_forwarding: 'never',
      required_headers: ['authorization', 'traceparent', 'baggage'],
      health: { path: '/healthz', success_status: 200 },
      audit: { action_result_required: true, metadata_fields: [] },
      conformance: { fixture_url: 'https://docs.caracal.run/schemas/caracal-gateway-upstream-manifest-2026-05-21.schema.json', tested_with_caracal: '0.1.2' },
    }))

    await manifestCommand(['validate', '--file', file, '--json'])

    expect(JSON.parse(stdout.mock.calls.map((c) => c[0]).join(''))).toMatchObject({
      valid: true,
      kind: 'gateway-upstream',
      schema_url: 'https://docs.caracal.run/schemas/caracal-gateway-upstream-manifest-2026-05-21.schema.json',
      errors: [],
    })
  })

  it('manifest validate rejects provider plugins that expose credentials outside Gateway', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caracal-manifest-'))
    const file = join(dir, 'provider.json')
    writeFileSync(file, JSON.stringify({
      schema_version: '2026-05-21',
      name: 'unsafe-provider',
      version: '1.0.0',
      provider_kinds: ['oauth2'],
      config_schema: { type: 'object' },
      secret_schema: { type: 'object' },
      lifecycle: { hooks: ['validate', 'resolve'] },
      audit_metadata: { fields: [] },
      execution: { isolation: 'external_service', credential_exposure: 'agent_visible' },
    }))

    await manifestCommand(['validate', '--file', file, '--json'])

    expect(JSON.parse(stdout.mock.calls.map((c) => c[0]).join(''))).toMatchObject({
      valid: false,
      kind: 'provider-credential-plugin',
      errors: ['execution.credential_exposure must be gateway_only'],
    })
  })

  it('policy template use creates a policy from template content', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === 'http://api/v1/policy-templates') {
        return [{ id: 'baseline-scopes', name: 'Baseline Scopes', description: 'Scope checks', content: 'package caracal.authz\nresult := {}' }]
      }
      expect(url).toBe('http://api/v1/zones/z1/policies')
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toMatchObject({
        name: 'Agent Gateway Policy',
        description: 'Scope checks',
        content: 'package caracal.authz\nresult := {}',
      })
      return { id: 'policy-1', version: { id: 'version-1' } }
    })
    await policyCommand(['template', 'use', 'baseline-scopes', '--name', 'Agent Gateway Policy'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stdout.mock.calls.map((c) => c[0]).join('')).toContain('policy-1')
  })

  it('protect provisions the Gateway-first local path', async () => {
    const calls: string[] = []
    stubFetch((url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`)
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      if (url === 'http://api/v1/zones/z1') {
        return { id: 'z1', name: 'Local', slug: 'local' }
      }
      if (url === 'http://api/v1/zones/z1/applications' && (init.method ?? 'GET') === 'GET') {
        return []
      }
      if (url === 'http://api/v1/zones/z1/applications' && init.method === 'POST') {
        expect(body).toMatchObject({ name: 'local-gateway-app', registration_method: 'managed', credential_type: 'token', traits: ['gateway'] })
        expect(body.client_secret).toMatch(/^cs_/)
        return { id: 'app-1', name: body.name, registration_method: 'managed', credential_type: 'token', traits: ['gateway'], consent: 'false', created_at: 't' }
      }
      if (url === 'http://api/v1/zones/z1/resources' && (init.method ?? 'GET') === 'GET') {
        return []
      }
      if (url === 'http://api/v1/zones/z1/resources' && init.method === 'POST') {
        expect(body).toMatchObject({ identifier: 'resource://local-tool', upstream_url: 'http://host.docker.internal:8090', gateway_application_id: 'app-1', scopes: ['tool:read'] })
        return { id: 'res-1', zone_id: 'z1', name: body.name, identifier: body.identifier, upstream_url: body.upstream_url, gateway_application_id: body.gateway_application_id, prefix: false, scopes: body.scopes, credential_provider_id: null, created_at: 't', updated_at: 't' }
      }
      if (url === 'http://api/v1/zones/z1/policies' && (init.method ?? 'GET') === 'GET') {
        return []
      }
      if (url === 'http://api/v1/zones/z1/policies' && init.method === 'POST') {
        expect(body).toMatchObject({ name: 'Local Gateway Scope Policy', schema_version: '2026-05-20' })
        expect(body.content).toContain('every scope in input.context.requested_scopes')
        return { id: 'pol-1', zone_id: 'z1', name: body.name, description: body.description, owner_type: 'customer', created_by: 'admin', created_at: 't', version: { id: 'pver-1', policy_id: 'pol-1', version: 1, content_sha256: 'sha', schema_version: '2026-05-20', created_at: 't' } }
      }
      if (url === 'http://api/v1/zones/z1/policy-sets' && (init.method ?? 'GET') === 'GET') {
        return []
      }
      if (url === 'http://api/v1/zones/z1/policy-sets' && init.method === 'POST') {
        return { id: 'pset-1', zone_id: 'z1', name: body.name, description: body.description, active_version_id: null, created_at: 't' }
      }
      if (url === 'http://api/v1/zones/z1/policy-sets/pset-1/versions') {
        expect(body).toEqual({ manifest: [{ policy_version_id: 'pver-1' }], schema_version: '2026-05-20' })
        return { id: 'psver-1', policy_set_id: 'pset-1', version: 1, manifest_sha256: 'sha', schema_version: '2026-05-20', created_at: 't' }
      }
      if (url === 'http://api/v1/zones/z1/policy-sets/pset-1/activate') {
        expect(body).toEqual({ version_id: 'psver-1' })
        return { activated: true, version_id: 'psver-1', shadow_version_id: null }
      }
      if (url === 'http://api/v1/zones/z1/grants' && (init.method ?? 'GET') === 'GET') {
        return []
      }
      if (url === 'http://api/v1/zones/z1/grants' && init.method === 'POST') {
        expect(body).toEqual({ application_id: 'app-1', user_id: 'local-user', resource_id: 'res-1', scopes: ['tool:read'] })
        return { id: 'grant-1', zone_id: 'z1', application_id: 'app-1', user_id: 'local-user', resource_id: 'res-1', scopes: ['tool:read'], status: 'active', created_at: 't' }
      }
      throw new Error(`unexpected request ${init.method ?? 'GET'} ${url}`)
    })

    await protectCommand(['http', '--zone', 'z1', '--identifier', 'resource://local-tool', '--upstream-url', 'http://host.docker.internal:8090', '--scopes', 'tool:read', '--user', 'local-user'])

    expect(calls).toEqual([
      'GET http://api/v1/zones/z1',
      'GET http://api/v1/zones/z1/applications',
      'POST http://api/v1/zones/z1/applications',
      'GET http://api/v1/zones/z1/resources',
      'POST http://api/v1/zones/z1/resources',
      'GET http://api/v1/zones/z1/policies',
      'POST http://api/v1/zones/z1/policies',
      'GET http://api/v1/zones/z1/policy-sets',
      'POST http://api/v1/zones/z1/policy-sets',
      'POST http://api/v1/zones/z1/policy-sets/pset-1/versions',
      'POST http://api/v1/zones/z1/policy-sets/pset-1/activate',
      'GET http://api/v1/zones/z1/grants',
      'POST http://api/v1/zones/z1/grants',
    ])
    const out = stdout.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('protected resource')
    expect(out).toContain('zone_url = "http://sts"')
    expect(out).toContain('application_id = "app-1"')
    expect(out).toContain('resource = "resource://local-tool"')
  })

  it('doctor reports control-plane readiness checks', async () => {
    stubFetch((url) => {
      if (url === 'http://api/health') return { ok: true }
      if (url === 'http://api/v1/zones') return [{ id: 'z1', name: 'Local', slug: 'local' }]
      if (url === 'http://api/v1/zones/z1') return { id: 'z1', name: 'Local', slug: 'local' }
      if (url === 'http://api/v1/zones/z1/resources') return [{ id: 'res-1' }]
      if (url === 'http://api/v1/zones/z1/policy-sets') return [{ id: 'pset-1', active_version_id: 'psver-1' }]
      if (url === 'http://api/v1/zones/z1/grants') return [{ id: 'grant-1' }]
      if (url === 'http://api/v1/zones/z1/audit?limit=1') return []
      throw new Error(`unexpected request ${url}`)
    })

    await doctorCommand(['--zone', 'z1'])

    const out = stdout.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('api health')
    expect(out).toContain('admin auth')
    expect(out).toContain('audit query')
  })

  it('doctor extended reports service readiness and metrics', async () => {
    process.env.CARACAL_STS_URL = 'http://sts'
    process.env.CARACAL_GATEWAY_URL = 'http://gateway'
    process.env.CARACAL_AUDIT_URL = 'http://audit'
    stubFetch((url) => {
      if (url === 'http://api/health') return { ok: true }
      if (url === 'http://api/v1/zones') return [{ id: 'z1', name: 'Local', slug: 'local' }]
      if (url === 'http://api/v1/zones/z1') return { id: 'z1', name: 'Local', slug: 'local' }
      if (url === 'http://api/v1/zones/z1/resources') return [{ id: 'res-1' }]
      if (url === 'http://api/v1/zones/z1/policy-sets') return [{ id: 'pset-1', active_version_id: 'psver-1' }]
      if (url === 'http://api/v1/zones/z1/grants') return [{ id: 'grant-1' }]
      if (url === 'http://api/v1/zones/z1/audit?limit=1') return []
      if (url.endsWith('/ready')) return { ready: true }
      if (url === 'http://sts/metrics.json') return { opa: { compile_errors: 0, eval_errors: 0, max_policy_age_seconds: 1 } }
      if (url === 'http://gateway/metrics.json') return { bindings_loaded: 3, revocations_active: 1, requests_denied: 2 }
      if (url === 'http://audit/metrics.json') return { consumer_lag: 0, dlq_size: 0, tamper_mismatch_total: 0 }
      if (url === 'http://coordinator/stats') return { outbox: { pending: 0, dead: 0 }, invocations: { running: 0 } }
      throw new Error(`unexpected request ${url}`)
    })

    await doctorCommand(['--zone', 'z1', '--extended'])

    const out = stdout.mock.calls.map((c) => c[0]).join('')
    expect(out).toContain('sts readiness')
    expect(out).toContain('opa compile_errors=0')
    expect(out).toContain('gateway metrics')
    expect(out).toContain('audit metrics')
    expect(out).toContain('coordinator metrics')
  })

  it('policy-set simulate posts version and input fixture', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://api/v1/zones/z1/policy-sets/pset-1/simulate')
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({
        version_id: 'psver-1',
        input: { schema_version: '2026-05-20', principal: { zone_id: 'z1' } },
      })
      return {
        dry_run: true,
        would_activate: true,
        policy_set_id: 'pset-1',
        version_id: 'psver-1',
        schema_version: '2026-05-20',
        input_schema_version: '2026-05-20',
        manifest_sha256: 'sha',
        policies: ['pver-1'],
        warnings: [],
        explanation: { evaluation: 'not_executed', reason: 'contract validated' },
      }
    })

    await policySetCommand(['simulate', 'pset-1', '--version', 'psver-1', '--input', '{"schema_version":"2026-05-20","principal":{"zone_id":"z1"}}'])

    const out = JSON.parse(stdout.mock.calls.map((c) => c[0]).join(''))
    expect(out).toMatchObject({ dry_run: true, policy_set_id: 'pset-1', warnings: [] })
  })

  it('audit command exits 1 when CARACAL_ADMIN_TOKEN is missing', async () => {
    const cwd = process.cwd()
    process.chdir(mkdtempSync(join(tmpdir(), 'caracal-empty-cwd-')))
    delete process.env.CARACAL_ADMIN_TOKEN
    delete process.env.CARACAL_ENV_FILE
    process.env.CARACAL_HOME = mkdtempSync(join(tmpdir(), 'caracal-empty-home-'))
    try {
      await expect(auditCommand(['tail'])).rejects.toThrow(/__exit:1/)
      expect(stderr.mock.calls.map((c) => c[0]).join('')).toContain('CARACAL_ADMIN_TOKEN')
    } finally {
      process.chdir(cwd)
    }
  })
})
