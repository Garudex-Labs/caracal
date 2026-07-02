// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the Diagnostics presentation model: component mapping, zone grouping, and issue building.

import { describe, expect, it } from 'vitest'

import {
  COMPONENT_ORDER,
  checkTitle,
  componentOf,
  issuesOf,
  stateOf,
  zoneHealthOf,
} from '../../../../apps/web/src/platform/api/diagnosticsModel.ts'
import type { DiagnosticCheck, DiagnosticsReport } from '../../../../apps/web/src/platform/api/types.ts'

const PIED_PIPER = '019f2111-8330-72cc-b027-8d644351f2e8'
const HOOLI = '019f2222-4444-72cc-b027-8d644351aaaa'

function check(partial: Partial<DiagnosticCheck> & { check: string }): DiagnosticCheck {
  return { section: 'health', status: 'ok', detail: 'ok', ...partial }
}

function report(checks: DiagnosticCheck[]): DiagnosticsReport {
  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    total: checks.length,
  }
  return {
    command: 'doctor',
    mode: 'system',
    ready: summary.fail === 0,
    strict: false,
    context: { apiUrl: 'http://localhost:3000', zoneScope: 'all', zoneIds: [] },
    summary,
    checks,
    generatedAt: '2026-01-01T00:00:00Z',
  }
}

const zoneNames = new Map([
  [PIED_PIPER, 'Pied Piper Production'],
  [HOOLI, 'Hooli Staging'],
])

describe('componentOf', () => {
  it('maps every health check to the control plane', () => {
    for (const name of ['api health', 'clock skew', 'admin auth', 'admin config']) {
      expect(componentOf(check({ section: 'health', check: name }))).toBe('controlPlane')
    }
  })

  it('maps readiness checks to their service component by name prefix', () => {
    expect(componentOf(check({ section: 'readiness', check: 'sts readiness' }))).toBe('authority')
    expect(componentOf(check({ section: 'readiness', check: 'gateway metrics' }))).toBe('gateway')
    expect(componentOf(check({ section: 'readiness', check: 'audit metrics' }))).toBe('audit')
    expect(componentOf(check({ section: 'readiness', check: 'coordinator readiness' }))).toBe('coordinator')
    expect(componentOf(check({ section: 'readiness', check: 'api readiness' }))).toBe('controlPlane')
  })

  it('maps preflight checks to the runtime environment and zone checks to no component', () => {
    expect(componentOf(check({ section: 'preflight', check: 'Postgres' }))).toBe('runtime')
    expect(componentOf(check({ section: 'zones', check: `${PIED_PIPER} lookup` }))).toBeNull()
  })

  it('covers every component key in the render order', () => {
    expect(COMPONENT_ORDER).toHaveLength(6)
  })
})

describe('stateOf', () => {
  it('collapses to the worst observed status', () => {
    expect(stateOf([check({ check: 'a' })])).toBe('operational')
    expect(stateOf([check({ check: 'a' }), check({ check: 'b', status: 'warn' })])).toBe('degraded')
    expect(stateOf([check({ check: 'a', status: 'warn' }), check({ check: 'b', status: 'fail' })])).toBe('outage')
    expect(stateOf([])).toBe('unknown')
  })
})

describe('checkTitle', () => {
  it('humanizes platform, readiness, and zone check names', () => {
    expect(checkTitle(check({ check: 'api health' }))).toBe('API reachability')
    expect(checkTitle(check({ check: 'clock skew' }))).toBe('Clock synchronization')
    expect(checkTitle(check({ section: 'readiness', check: 'sts readiness' }))).toBe('Service readiness')
    expect(checkTitle(check({ section: 'readiness', check: 'audit metrics' }))).toBe('Operational metrics')
    expect(checkTitle(check({ section: 'zones', check: `${PIED_PIPER} policy sets` }))).toBe('Policy enforcement')
  })

  it('passes preflight check names through unchanged', () => {
    expect(checkTitle(check({ section: 'preflight', check: 'TLS cert' }))).toBe('TLS cert')
    expect(checkTitle(check({ section: 'preflight', check: 'Redis' }))).toBe('Redis')
  })
})

describe('zoneHealthOf', () => {
  it('groups zone checks per zone with the worst state', () => {
    const result = zoneHealthOf(
      report([
        check({ check: 'api health' }),
        check({ section: 'zones', check: `${PIED_PIPER} lookup` }),
        check({ section: 'zones', check: `${PIED_PIPER} audit query`, status: 'fail' }),
        check({ section: 'zones', check: `${HOOLI} lookup` }),
      ]),
    )
    expect(result.zones).toHaveLength(2)
    const piedPiper = result.zones.find((z) => z.zoneId === PIED_PIPER)
    expect(piedPiper?.state).toBe('outage')
    expect(piedPiper?.checks).toHaveLength(2)
    expect(result.zones.find((z) => z.zoneId === HOOLI)?.state).toBe('operational')
    expect(result.inventory).toBeUndefined()
  })

  it('surfaces the zone inventory check when no zones exist', () => {
    const result = zoneHealthOf(
      report([check({ section: 'zones', check: 'zone inventory', status: 'warn', detail: 'No zones are visible.' })]),
    )
    expect(result.zones).toHaveLength(0)
    expect(result.inventory?.detail).toBe('No zones are visible.')
  })
})

describe('issuesOf', () => {
  it('builds severity-sorted issues with zone names, impact, and contextual links', () => {
    const issues = issuesOf(
      report([
        check({ check: 'api health' }),
        check({ section: 'readiness', check: 'sts metrics', status: 'warn', detail: 'eval errors', advice: 'Review policies.' }),
        check({
          section: 'zones',
          check: `${PIED_PIPER} policy sets`,
          status: 'fail',
          detail: 'HTTP 500',
          advice: 'Inspect activation state.',
        }),
      ]),
      zoneNames,
    )
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({
      severity: 'critical',
      title: 'Pied Piper Production · Policy enforcement',
      explanation: 'HTTP 500',
      guidance: 'Inspect activation state.',
      link: { label: 'Open policy sets', sub: '/policies', zoneId: PIED_PIPER },
    })
    expect(issues[0].impact).toBeTruthy()
    expect(issues[1]).toMatchObject({
      severity: 'warning',
      title: 'Authority (STS) · Operational metrics',
      guidance: 'Review policies.',
    })
    expect(issues[1].impact).toBeUndefined()
  })

  it('offers zone creation when the inventory is empty', () => {
    const issues = issuesOf(
      report([check({ section: 'zones', check: 'zone inventory', status: 'warn', detail: 'No zones are visible.' })]),
      zoneNames,
    )
    expect(issues[0]).toMatchObject({
      severity: 'warning',
      title: 'No zones available',
      link: { label: 'Create a zone', sub: '/zones' },
    })
  })

  it('falls back to the zone id when the zone name is unknown', () => {
    const issues = issuesOf(
      report([check({ section: 'zones', check: 'unknown-zone lookup', status: 'fail', detail: 'HTTP 404' })]),
      zoneNames,
    )
    expect(issues[0].title).toBe('unknown-zone · Zone lookup')
    expect(issues[0].link).toEqual({ label: 'Open zones', sub: '/zones' })
  })

  it('returns no issues when everything passes', () => {
    expect(issuesOf(report([check({ check: 'api health' })]), zoneNames)).toHaveLength(0)
  })
})
