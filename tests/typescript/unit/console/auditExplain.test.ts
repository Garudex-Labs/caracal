// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Request trace and audit views expose low-friction request investigation.

import { afterEach, describe, it, expect, vi } from 'vitest'

import { MenuView } from '../../../../apps/console/src/views/menu.ts'
import { FormView } from '../../../../apps/console/src/views/form.ts'
import { DetailView } from '../../../../apps/console/src/views/detail.ts'
import type { App } from '../../../../apps/console/src/screen.ts'
import type { AdminClient } from '@caracalai/admin'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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

describe('request trace entry', () => {
  it('submits request_id and pushes a populated DetailView', async () => {
    const explain = vi.fn(async () => ({ request_id: 'req-42', decision: 'allow' }))
    const client = { audit: { explain } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()
    await menu.onKey('t', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const form = pushed[pushed.length - 1] as FormView
    expect(form).toBeInstanceOf(FormView)
    ;(form as unknown as { values: Record<string, string> }).values = { request_id: 'req-42' }
    ;(form as unknown as { focus: number }).focus = 1
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })
    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
    await detail.init(app)
    const body = detail.render({ app, size: { rows: 20, cols: 80 }, status: '' }).join('\n')
    expect(body).toContain('Request ID')
    expect(body).toContain('req-42')
    expect(body).toContain('Decision')
    expect(body).toContain('allow')
    expect(explain).toHaveBeenCalledWith('z1', 'req-42')
  })

  it('opens audit tail directly with default filters', async () => {
    const list = vi.fn(async () => [])
    const client = { audit: { list, byRequest: vi.fn(), explain: vi.fn() } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()
    await menu.onKey('a', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const tail = pushed[pushed.length - 1] as { init: (app: App) => Promise<void> }
    await tail.init(app)
    expect(list).toHaveBeenCalledWith('z1', { limit: 100, decision: undefined })
  })

  it('keeps advanced audit filters available from the tail', async () => {
    const list = vi.fn(async () => [])
    const client = { audit: { list, byRequest: vi.fn(), explain: vi.fn() } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()
    await menu.onKey('a', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const tail = pushed[pushed.length - 1] as { init: (app: App) => Promise<void>; onKey: MenuView['onKey'] }
    await tail.onKey('f', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    expect(form).toBeInstanceOf(FormView)
    ;(form as unknown as { values: Record<string, string> }).values = {
      request_id: 'req-1',
      decision: 'deny',
      event_type: 'authorization',
      since: '2026-01-01T00:00:00Z',
      until: '',
      limit: '25',
    }
    ;(form as unknown as { focus: number }).focus = 2
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })
    await tail.init(app)
    expect(list).toHaveBeenCalledWith('z1', {
      decision: 'deny',
      since: '2026-01-01T00:00:00Z',
      request_id: 'req-1',
      event_type: 'authorization',
      limit: 25,
    })
  })

  it('renders the production menu with Control API management', () => {
    const client = { audit: { byRequest: vi.fn() } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const body = menu.render({ app: fakeApp(), size: { rows: 25, cols: 80 }, status: '' }).join('\n')
    expect(body).toContain('diagnostics')
    expect(body).not.toContain(' c  credential')
    expect(body).toContain('control')
  })

  it('opens control key get and loads the selected key', async () => {
    const get = vi.fn(async () => ({
      id: 'app-1',
      name: 'control',
      traits: ['control:invoke'],
      registration_method: 'managed',
    }))
    const client = {
      audit: { byRequest: vi.fn() },
      applications: { get },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const control = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await control.onKey('g', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    expect(typeof (form as unknown as { fields: { pick?: unknown }[] }).fields[0]?.pick).toBe('function')
    ;(form as unknown as { values: Record<string, string> }).values = { id: 'app-1' }
    ;(form as unknown as { focus: number }).focus = 1
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })
    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
    await detail.init(app)
    expect(get).toHaveBeenCalledWith('z1', 'app-1', { applicationInternals: true })
  })

  it('creates control keys with explicit permissions and restrictions', async () => {
    const createResource = vi.fn(async (_zoneId: string, input: Record<string, unknown>) => ({
      id: 'res-1',
      zone_id: 'z1',
      identifier: input.identifier,
      scopes: input.scopes,
    }))
    const createApp = vi.fn(async (_zoneId: string, input: Record<string, unknown>) => ({
      id: 'app-1',
      zone_id: 'z1',
      created_at: 'now',
      client_secret: 'cs_generated',
      ...input,
    }))
    const client = {
      audit: { byRequest: vi.fn() },
      resources: { list: vi.fn(async () => []), create: createResource },
      applications: { create: createApp },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const control = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await control.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    const fields = (form as unknown as { fields: { key: string; pick?: unknown }[] }).fields
    expect(fields.map((field) => field.key)).toEqual(['name', 'scopes', 'max_ttl_seconds', 'expires_in_days'])
    expect(typeof fields[1]?.pick).toBe('function')

    ;(form as unknown as { values: Record<string, string> }).values = {
      name: 'robot',
      scopes: 'control:agent:read',
      max_ttl_seconds: '300',
      expires_in_days: '1',
    }
    ;(form as unknown as { focus: number }).focus = 4
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

    expect(createApp).toHaveBeenCalledWith('z1', expect.objectContaining({
      name: 'robot',
      traits: expect.arrayContaining([
        'control:invoke',
        'control:scope:control:agent:read',
        'control:max-ttl:300',
      ]),
    }))
    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
  })

  it('uses c for Control and does not expose resource credential tools from the Console menu', async () => {
    const client = { audit: { byRequest: vi.fn() } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toEqual(expect.objectContaining({ title: 'control' }))
  })

  it('issues control invocation tokens only through scoped control keys', async () => {
    vi.stubEnv('CARACAL_ZONE_URL', 'https://sts.example.com')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'control-token',
      token_type: 'Bearer',
      expires_in: 300,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = {
      audit: { byRequest: vi.fn() },
      applications: {
        get: vi.fn(async () => ({
          id: 'control-app',
          name: 'robot',
          traits: ['control:invoke', 'control:scope:control:agent:read'],
          created_at: 'now',
        })),
      },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const control = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await control.onKey('t', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      id: 'control-app',
      client_secret: 'secret',
      scopes: 'control:agent:read',
      ttl_seconds: '300',
    }
    ;(form as unknown as { focus: number }).focus = 4
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

    const request = fetchMock.mock.calls[0][1] as { body: URLSearchParams }
    expect(request.body.get('application_id')).toBe('control-app')
    expect(request.body.get('resource')).toBe('caracal-control')
    expect(request.body.get('scope')).toBe('control:agent:read')
    expect(request.body.get('ttl_seconds')).toBe('300')
    const detail = pushed[pushed.length - 1] as DetailView
    await detail.init(app)
    const body = detail.render({ app, size: { rows: 25, cols: 80 }, status: '' }).join('\n')
    expect(body).toContain('caracal-control')
    expect(body).toContain('••••')
  })

  it('blocks control token scopes that are not granted to the key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = {
      audit: { byRequest: vi.fn() },
      applications: {
        get: vi.fn(async () => ({
          id: 'control-app',
          name: 'robot',
          traits: ['control:invoke', 'control:scope:control:agent:read'],
          created_at: 'now',
        })),
      },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const control = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await control.onKey('t', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      id: 'control-app',
      client_secret: 'secret',
      scopes: 'control:application:write',
      ttl_seconds: '300',
    }
    ;(form as unknown as { focus: number }).focus = 4
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })
    expect(app.setStatus).toHaveBeenCalledWith(
      'control key control-app does not grant control:application:write',
      'error',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

})
