// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the shared doctor diagnostics used by Console operator health checks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../packages/engine/src/preflight.js', () => ({
  runPreflightChecks: vi.fn(async () => [
    { check: 'env', status: 'ok', detail: 'all good' },
    { check: 'secrets', status: 'warn', detail: 'missing optional secret' },
  ]),
}))

vi.mock('../../../../packages/engine/src/shared.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, buildAdminClient: vi.fn() }
})

vi.mock('@caracalai/core', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, discoverCoordinatorToken: vi.fn(() => undefined) }
})

import { runDoctorDiagnostics, doctorShouldFail } from '../../../../packages/engine/src/doctor.js'
import { buildAdminClient } from '../../../../packages/engine/src/shared.js'
import { discoverCoordinatorToken } from '@caracalai/core'

const SAVED = { ...process.env }

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function textResponse(text: string, ok = false, status = 500): Response {
  return {
    ok,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response
}

function jsonResponseWithDate(body: unknown, date: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'date' ? date : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function fakeAdminContext(overrides: Record<string, unknown> = {}) {
  return {
    apiUrl: 'http://localhost:3000',
    zoneId: undefined,
    client: {
      zones: {
        list: vi.fn(async () => [{ id: 'z1', name: 'Zone One' }]),
        get: vi.fn(async (id: string) => ({ id, name: 'Zone One' })),
      },
      resources: { list: vi.fn(async () => [{ id: 'r1' }]) },
      policySets: { list: vi.fn(async () => [{ id: 'p1', active_version_id: 'v1' }]) },
      audit: { list: vi.fn(async () => []) },
      ...overrides,
    },
  }
}

beforeEach(() => {
  process.env = {
    ...SAVED,
    CARACAL_MODE: 'dev',
    CARACAL_API_URL: 'http://localhost:3000',
    CARACAL_STS_URL: 'http://localhost:8080',
    CARACAL_GATEWAY_URL: 'http://localhost:8081',
    CARACAL_AUDIT_URL: 'http://localhost:9090',
    CARACAL_COORDINATOR_URL: 'http://localhost:4000',
  }
  vi.clearAllMocks()
})

afterEach(() => {
  process.env = { ...SAVED }
  vi.restoreAllMocks()
})

describe('runDoctorDiagnostics — preflight only', () => {
  it('reports only the preflight section', async () => {
    const report = await runDoctorDiagnostics({ preflightOnly: true })
    expect(report.mode).toBe('preflight')
    expect(report.context.zoneScope).toBe('none')
    expect(report.checks.every((c) => c.section === 'preflight')).toBe(true)
    expect(report.summary.total).toBe(2)
    expect(report.ready).toBe(true)
    expect(doctorShouldFail(report)).toBe(false)
  })
})

describe('runDoctorDiagnostics — full system run', () => {
  it('runs health, zone, readiness, and preflight checks for all zones', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext() as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health') || url.endsWith('/ready')) return jsonResponse({}, true)
      if (url.endsWith('/stats')) return jsonResponse({ outbox: { pending: 0, dead: 0 }, invocations: { running: 1 } })
      return jsonResponse({ opa: { compile_errors: 0 }, bindings_loaded: 2, consumer_lag: 0 })
    })

    const report = await runDoctorDiagnostics({})
    expect(report.mode).toBe('system')
    expect(report.context.zoneScope).toBe('all')
    expect(report.context.zoneIds).toEqual(['z1'])
    expect(report.checks.some((c) => c.section === 'health' && c.check === 'api health')).toBe(true)
    expect(report.checks.some((c) => c.section === 'zones' && c.check === 'z1 resources')).toBe(true)
    expect(report.checks.some((c) => c.section === 'readiness')).toBe(true)
    expect(report.ready).toBe(true)
    fetchSpy.mockRestore()
  })

  it('emits a coordinator metrics warn when unauthenticated and a 401 is returned', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext({ zones: { list: vi.fn(async () => []), get: vi.fn() } }) as never)
    vi.mocked(discoverCoordinatorToken).mockReturnValue(undefined)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/ready') || url.endsWith('/health')) return jsonResponse({}, true)
      if (url.endsWith('/stats')) return textResponse('{"reason":"unauthorized"}', false, 401)
      return jsonResponse({})
    })

    const report = await runDoctorDiagnostics({})
    const coordMetrics = report.checks.find((c) => c.check === 'coordinator metrics')
    expect(coordMetrics?.status).toBe('warn')
    expect(report.checks.some((c) => c.check === 'zone inventory' && c.status === 'warn')).toBe(true)
    fetchSpy.mockRestore()
  })

  it('marks api health as fail when the probe rejects', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext() as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) return textResponse('{"error":"down"}', false, 503)
      return jsonResponse({}, true)
    })

    const report = await runDoctorDiagnostics({ strict: true })
    const apiHealth = report.checks.find((c) => c.check === 'api health')
    expect(apiHealth?.status).toBe('fail')
    expect(report.ready).toBe(false)
    expect(doctorShouldFail(report)).toBe(true)
    fetchSpy.mockRestore()
  })

  it('records an admin config failure when the client cannot be built', async () => {
    vi.mocked(buildAdminClient).mockImplementation(() => {
      throw new Error('missing CARACAL_ADMIN_TOKEN')
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, true))

    const report = await runDoctorDiagnostics({})
    const adminConfig = report.checks.find((c) => c.check === 'admin config')
    expect(adminConfig?.status).toBe('fail')
    expect(adminConfig?.advice).toBe('Run `pnpm caracal up` to provision local admin credentials.')
    expect(report.context.zoneScope).toBe('none')
    fetchSpy.mockRestore()
  })

  it('runs a single selected zone when a zoneId is supplied', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext() as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, true))

    const report = await runDoctorDiagnostics({ zoneId: 'zone-x' })
    expect(report.context.zoneScope).toBe('selected')
    expect(report.context.zoneIds).toEqual(['zone-x'])
    expect(report.checks.some((c) => c.check === 'zone-x lookup')).toBe(true)
    fetchSpy.mockRestore()
  })

  it('fails when audit reports a chain integrity violation', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext() as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health') || url.endsWith('/ready')) return jsonResponse({}, true)
      if (url.endsWith('/stats')) return jsonResponse({ outbox: { pending: 0, dead: 0 }, invocations: { running: 0 } })
      if (url.includes(':9090')) return jsonResponse({ consumer_lag: 0, dlq_size: 0, tamper_mismatch_total: 3 })
      return jsonResponse({ opa: { compile_errors: 0 } })
    })

    const report = await runDoctorDiagnostics({})
    const auditMetrics = report.checks.find((c) => c.check === 'audit metrics')
    expect(auditMetrics?.status).toBe('fail')
    expect(auditMetrics?.advice).toMatch(/integrity/i)
    expect(report.ready).toBe(false)
    fetchSpy.mockRestore()
  })

  it('fails when STS cannot compile a policy bundle', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext() as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health') || url.endsWith('/ready')) return jsonResponse({}, true)
      if (url.endsWith('/stats')) return jsonResponse({ outbox: { pending: 0, dead: 0 } })
      if (url.includes(':8080')) return jsonResponse({ opa: { compile_errors: 1, eval_errors: 0 } })
      return jsonResponse({})
    })

    const report = await runDoctorDiagnostics({})
    const stsMetrics = report.checks.find((c) => c.check === 'sts metrics')
    expect(stsMetrics?.status).toBe('fail')
    expect(report.ready).toBe(false)
    fetchSpy.mockRestore()
  })

  it('warns when the coordinator outbox has dead rows', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext() as never)
    vi.mocked(discoverCoordinatorToken).mockReturnValue('coord-token')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health') || url.endsWith('/ready')) return jsonResponse({}, true)
      if (url.endsWith('/stats')) return jsonResponse({ outbox: { pending: 0, dead: 4 }, invocations: { running: 0 } })
      return jsonResponse({ opa: { compile_errors: 0 } })
    })

    const report = await runDoctorDiagnostics({})
    const coordMetrics = report.checks.find((c) => c.check === 'coordinator metrics')
    expect(coordMetrics?.status).toBe('warn')
    expect(coordMetrics?.advice).toMatch(/dead outbox/i)
    expect(report.ready).toBe(true)
    fetchSpy.mockRestore()
  })

  it('fails the clock skew check when the api clock is far from the operator', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext() as never)
    const farDate = new Date(Date.now() - 5 * 60 * 1000).toUTCString()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponseWithDate({}, farDate)
      if (url.endsWith('/ready')) return jsonResponse({}, true)
      if (url.endsWith('/stats')) return jsonResponse({ outbox: { pending: 0, dead: 0 } })
      return jsonResponse({ opa: { compile_errors: 0 } })
    })

    const report = await runDoctorDiagnostics({})
    const skew = report.checks.find((c) => c.section === 'health' && c.check === 'clock skew')
    expect(skew?.status).toBe('fail')
    expect(skew?.advice).toMatch(/NTP/)
    expect(report.ready).toBe(false)
    fetchSpy.mockRestore()
  })

  it('passes the clock skew check when the api clock matches', async () => {
    vi.mocked(buildAdminClient).mockReturnValue(fakeAdminContext() as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponseWithDate({}, new Date().toUTCString())
      if (url.endsWith('/ready')) return jsonResponse({}, true)
      if (url.endsWith('/stats')) return jsonResponse({ outbox: { pending: 0, dead: 0 } })
      return jsonResponse({ opa: { compile_errors: 0 } })
    })

    const report = await runDoctorDiagnostics({})
    const skew = report.checks.find((c) => c.section === 'health' && c.check === 'clock skew')
    expect(skew?.status).toBe('ok')
    fetchSpy.mockRestore()
  })
})
