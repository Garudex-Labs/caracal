// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// audit-explain form submits the request_id and pushes a populated DetailView.

import { describe, it, expect, vi } from 'vitest'

import { MenuView } from '../../../../apps/tui/src/views/menu.ts'
import { FormView } from '../../../../apps/tui/src/views/form.ts'
import { DetailView } from '../../../../apps/tui/src/views/detail.ts'
import type { App } from '../../../../apps/tui/src/screen.ts'
import type { AdminClient } from '@caracalai/admin'

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
    const byRequest = vi.fn(async () => ({ request_id: 'req-42', decision: 'allow' }))
    const client = { audit: { byRequest } } as unknown as AdminClient
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
    expect(byRequest).toHaveBeenCalledWith('z1', 'req-42')
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
    ;(form as unknown as { values: Record<string, string> }).values = { id: 'app-1' }
    ;(form as unknown as { focus: number }).focus = 1
    await form.onKey('enter', { app, size: { rows: 25, cols: 80 }, status: '' })
    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
    await detail.init(app)
    expect(get).toHaveBeenCalledWith('z1', 'app-1')
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

})
