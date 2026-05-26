// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// audit-explain form submits the request_id and pushes a populated DetailView.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('audit explain entry', () => {
  it('submits request_id and pushes a populated DetailView', async () => {
    const explain = vi.fn(async () => ({ request_id: 'req-42', decision: 'allow' }))
    const client = { audit: { explain } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()
    await menu.onKey('x', { app, size: { rows: 25, cols: 80 }, status: '' })
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

  it('opens audit filters before tailing events', async () => {
    const list = vi.fn(async () => [])
    const client = { audit: { list, byRequest: vi.fn() } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()
    await menu.onKey('9', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const form = pushed[pushed.length - 1] as FormView
    expect(form).toBeInstanceOf(FormView)
    ;(form as unknown as { values: Record<string, string> }).values = {
      decision: 'deny',
      since: '2026-01-01T00:00:00Z',
      until: '',
      request_id: 'req-1',
      event_type: 'authorization',
      limit: '25',
    }
    ;(form as unknown as { focus: number }).focus = 6
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })
    const tail = pushed[pushed.length - 1] as { init: (app: App) => Promise<void> }
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
    expect(body).toContain('doctor')
    expect(body).toContain('credential')
    expect(body).toContain('control')
  })

  it('opens control key get and loads the selected key', async () => {
    const get = vi.fn(async () => ({
      id: 'app-1',
      name: 'control',
      traits: ['control:invoke'],
      registration_method: 'managed',
      credential_type: 'token',
    }))
    const client = {
      audit: { byRequest: vi.fn() },
      applications: { get },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('t', { app, size: { rows: 25, cols: 80 }, status: '' })
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
    expect(get).toHaveBeenCalledWith('z1', 'app-1')
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
      ...input,
    }))
    const client = {
      audit: { byRequest: vi.fn() },
      resources: { list: vi.fn(async () => []), create: createResource },
      applications: { create: createApp },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('t', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const control = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await control.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    const fields = (form as unknown as { fields: { key: string; pick?: unknown }[] }).fields
    expect(fields.map((field) => field.key)).toEqual(['name', 'scopes', 'max_ttl_seconds', 'expires_in_days'])
    expect(typeof fields[1]?.pick).toBe('function')

    ;(form as unknown as { values: Record<string, string> }).values = {
      name: 'robot',
      scopes: 'control:zone:read',
      max_ttl_seconds: '300',
      expires_in_days: '1',
    }
    ;(form as unknown as { focus: number }).focus = 4
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

    expect(createApp).toHaveBeenCalledWith('z1', expect.objectContaining({
      name: 'robot',
      traits: expect.arrayContaining([
        'control:invoke',
        'control:scope:control:zone:read',
        'control:max-ttl:300',
      ]),
    }))
    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
  })

  it('opens credential read with a resource picker', async () => {
    const client = {
      audit: { byRequest: vi.fn() },
      resources: { list: vi.fn(async () => []) },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const credential = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await credential.onKey('r', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView

    expect(typeof (form as unknown as { fields: { pick?: unknown }[] }).fields[0]?.pick).toBe('function')
  })

  it('points Control API token requests to the Control menu', async () => {
    const client = { audit: { byRequest: vi.fn() } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const credential = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await credential.onKey('r', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    ;(form as unknown as { values: Record<string, string> }).values = { resource: 'caracal-control', application_id: 'app1' }
    const fields = (form as unknown as { fields: unknown[] }).fields
    ;(form as unknown as { focus: number }).focus = fields.length
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

    expect(app.setStatus).toHaveBeenCalledWith(
      'Control API tokens are issued from control → issue invocation token',
      'error',
    )
  })

  it('reads credentials from selected application fields without loading runtime config', async () => {
    const cwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), 'caracal-console-credential-'))
    const configDir = join(dir, '.config', 'caracal')
    mkdirSync(configDir, { recursive: true })
    const secretPath = join(configDir, 'runtime-secret')
    const configPath = join(configDir, 'caracal.toml')
    writeFileSync(secretPath, 'runtime-secret\n')
    writeFileSync(configPath, [
      'zone_url = "https://runtime-sts.example.com"',
      'zone_id = "runtime-zone"',
      'application_id = "runtime-app"',
      `app_client_secret_file = "${secretPath}"`,
      '[[credentials]]',
      'env = "RESOURCE_TOKEN"',
      'resource = "resource://runtime"',
      '',
    ].join('\n'))
    if (process.platform !== 'win32') {
      chmodSync(secretPath, 0o600)
      chmodSync(configPath, 0o600)
    }
    vi.stubEnv('PWD', dir)
    vi.stubEnv('INIT_CWD', dir)
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, '.config'))
    vi.stubEnv('CARACAL_ZONE_URL', 'https://sts.example.com')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'token-value',
      token_type: 'Bearer',
      expires_in: 900,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = {
      audit: { byRequest: vi.fn() },
      resources: { list: vi.fn(async () => []) },
      applications: { list: vi.fn(async () => []) },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    try {
      process.chdir(dir)
      await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
      const pushed = (app as unknown as { _pushed: unknown[] })._pushed
      const credential = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
      await credential.onKey('r', { app, size: { rows: 25, cols: 80 }, status: '' })
      const form = pushed[pushed.length - 1] as FormView
      const fields = (form as unknown as { fields: { key: string; pick?: unknown }[] }).fields
      expect(fields.map((field) => field.key)).toEqual(['resource', 'application_id', 'app_client_secret'])
      expect(typeof fields[1]?.pick).toBe('function')

      ;(form as unknown as { values: Record<string, string> }).values = {
        resource: 'resource://api',
        application_id: 'app-1',
        app_client_secret: 'secret',
      }
      ;(form as unknown as { focus: number }).focus = 3
      await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

      expect(fetchMock).toHaveBeenCalledWith('https://sts.example.com/oauth/2/token', expect.objectContaining({
        method: 'POST',
      }))
      expect(fetchMock).not.toHaveBeenCalledWith('https://runtime-sts.example.com/oauth/2/token', expect.anything())
      const detail = pushed[pushed.length - 1] as DetailView
      expect(detail).toBeInstanceOf(DetailView)
      await detail.init(app)
      const body = detail.render({ app, size: { rows: 25, cols: 80 }, status: '' }).join('\n')
      expect(body).toContain('resource://api')
      expect(body).toContain('••••')
    } finally {
      process.chdir(cwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens credential inspect and decodes local JWT claims', async () => {
    const client = { audit: { byRequest: vi.fn() } } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = `${encode({ alg: 'none', kid: 'k1' })}.${encode({ sub: 'user-1', exp: 4_102_444_800 })}.signature`

    await menu.onKey('c', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const credential = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await credential.onKey('i', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    ;(form as unknown as { values: Record<string, string> }).values = { token, file: '' }
    ;(form as unknown as { focus: number }).focus = 2
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
    await detail.init(app)
    const body = detail.render({ app, size: { rows: 25, cols: 80 }, status: '' }).join('\n')
    expect(body).toContain('user-1')
    expect(body).toContain('k1')
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
          credential_type: 'token',
          traits: ['control:invoke', 'control:scope:control:zone:read'],
          created_at: 'now',
        })),
      },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('t', { app, size: { rows: 25, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const control = pushed[pushed.length - 1] as { onKey: MenuView['onKey'] }
    await control.onKey('t', { app, size: { rows: 25, cols: 80 }, status: '' })
    const form = pushed[pushed.length - 1] as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      id: 'control-app',
      client_secret: 'secret',
      scopes: 'control:zone:read',
      ttl_seconds: '300',
    }
    ;(form as unknown as { focus: number }).focus = 4
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })

    const request = fetchMock.mock.calls[0][1] as { body: URLSearchParams }
    expect(request.body.get('application_id')).toBe('control-app')
    expect(request.body.get('resource')).toBe('caracal-control')
    expect(request.body.get('scope')).toBe('control:zone:read')
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
          credential_type: 'token',
          traits: ['control:invoke', 'control:scope:control:zone:read'],
          created_at: 'now',
        })),
      },
    } as unknown as AdminClient
    const menu = new MenuView(client, 'z1')
    const app = fakeApp()

    await menu.onKey('t', { app, size: { rows: 25, cols: 80 }, status: '' })
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
