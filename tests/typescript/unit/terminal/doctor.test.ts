// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// DoctorView runs shared diagnostics and renders operator-friendly health output.

import { describe, it, expect, vi } from 'vitest'
import { runDoctorDiagnostics } from '@caracalai/engine'
import { MenuView } from '../../../../apps/tui/src/views/menu.ts'
import { DoctorView } from '../../../../apps/tui/src/views/doctor.ts'
import type { App } from '../../../../apps/tui/src/screen.ts'
import type { AdminClient } from '@caracalai/admin'

vi.mock('@caracalai/engine', async () => {
  const actual = await vi.importActual<typeof import('@caracalai/engine')>('@caracalai/engine')
  return {
    ...actual,
    runDoctorDiagnostics: vi.fn(async (options?: { zoneId?: string; strict?: boolean; preflightOnly?: boolean }) => ({
      command: 'doctor',
      mode: options?.preflightOnly ? 'preflight' : 'system',
      ready: !options?.strict,
      strict: Boolean(options?.strict),
      context: {
        apiUrl: 'http://api',
        zoneScope: options?.zoneId ? 'selected' : 'all',
        zoneIds: options?.zoneId ? [options.zoneId] : ['z1', 'z2'],
      },
      summary: { ok: 1, warn: options?.strict ? 1 : 0, fail: 0, total: options?.strict ? 2 : 1 },
      checks: [
        { section: 'health', check: 'api health', status: 'ok', detail: 'http://api/health' },
        ...(options?.strict ? [{ section: 'preflight', check: 'TLS files', status: 'warn', detail: 'not configured', advice: 'Configure TLS before production.' }] : []),
      ],
    })),
  }
})

function fakeApp(): App {
  const pushed: unknown[] = []
  const app = {
    invalidate: vi.fn(),
    push: vi.fn((v: unknown) => { pushed.push(v) }),
    pop: vi.fn(),
    setStatus: vi.fn(),
    current: vi.fn(),
    exit: vi.fn(async () => {}),
    replaceTop: vi.fn(),
    bannerLeft: '',
    bannerRight: '',
  } as unknown as App
  ;(app as unknown as { _pushed: unknown[] })._pushed = pushed
  return app
}

describe('doctor TUI integration', () => {
  it('opens a live diagnostics screen from the main menu', async () => {
    const client = { zones: { list: vi.fn(async () => []) } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('d', { app, size: { rows: 25, cols: 100 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const doctor = pushed[pushed.length - 1] as DoctorView
    expect(doctor).toBeInstanceOf(DoctorView)

    await doctor.init(app)
    const body = doctor.render({ app, size: { rows: 25, cols: 100 }, status: '' }).join('\n')
    expect(runDoctorDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ zoneId: 'z1', preflightOnly: false }))
    expect(body).toContain('Doctor Diagnostics')
    expect(body).toContain('System health')
    expect(body).toContain('api health')
    expect(body).not.toContain('"checks"')
  })

  it('switches between all-zone, preflight, and strict readiness modes', async () => {
    const app = fakeApp()
    const doctor = new DoctorView({ zoneId: 'z1' })
    await doctor.init(app)

    await doctor.onKey('a', { app, size: { rows: 25, cols: 100 }, status: '' })
    expect(runDoctorDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ zoneId: undefined, preflightOnly: false }))

    await doctor.onKey('p', { app, size: { rows: 25, cols: 100 }, status: '' })
    expect(runDoctorDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ zoneId: undefined, preflightOnly: true }))

    await doctor.onKey('s', { app, size: { rows: 25, cols: 100 }, status: '' })
    expect(runDoctorDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ strict: true }))
    const body = doctor.render({ app, size: { rows: 25, cols: 100 }, status: '' }).join('\n')
    expect(body).toContain('Next actions')
    expect(body).toContain('Configure TLS before production.')
  })
})
