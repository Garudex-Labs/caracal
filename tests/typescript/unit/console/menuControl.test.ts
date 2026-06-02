// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control menu tests cover status, lifecycle, and credential management paths.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App, View } from '../../../../apps/console/src/screen.ts'

const engineMocks = vi.hoisted(() => ({
  DEFAULT_CONTROL_AUDIENCE: 'resource://control',
  applyControlLifecycleAction: vi.fn(),
  authorizeControlManagementAccess: vi.fn(),
  controlKeyCreate: vi.fn(),
  controlKeyGet: vi.fn(),
  controlKeyList: vi.fn(),
  controlKeyRevoke: vi.fn(),
  controlKeyRotate: vi.fn(),
  controlPermissions: vi.fn(),
  controlServiceStatus: vi.fn(),
  credentialRead: vi.fn(),
  readControlState: vi.fn(),
  resolveStackPaths: vi.fn(),
}))

vi.mock('@caracalai/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caracalai/engine')>()
  return { ...actual, ...engineMocks }
})

vi.mock('@caracalai/engine/runtime-config', () => ({
  resolveStsUrl: vi.fn(() => 'https://sts.pipernet.example'),
}))

const { MenuView } = await import('../../../../apps/console/src/views/menu.ts')

function fakeApp(): App {
  const pushed: unknown[] = []
  const status: { text: string; kind: string }[] = []
  const app = {
    invalidate: vi.fn(),
    push: vi.fn((view: unknown) => { pushed.push(view) }),
    pop: vi.fn(),
    setStatus: vi.fn((text: string, kind: 'info' | 'error' = 'info') => { status.push({ text, kind }) }),
    current: vi.fn(),
    exit: vi.fn(async () => {}),
    replaceTop: vi.fn(),
    bannerLeft: '',
    bannerRight: '',
  } as unknown as App
  ;(app as unknown as { _pushed: unknown[]; _status: typeof status })._pushed = pushed
  ;(app as unknown as { _pushed: unknown[]; _status: typeof status })._status = status
  return app
}

function latest<T>(app: App): T {
  const pushed = (app as unknown as { _pushed: T[] })._pushed
  return pushed[pushed.length - 1]!
}

function controlStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'enabled',
    service: 'running',
    mounted: true,
    enabled: true,
    invokeUrl: 'https://control.pipernet.example/v1/control/invoke',
    lifecycle: 'ready',
    optimization: 'warm',
    marker: '/tmp/caracal-control.json',
    detail: 'healthy',
    ...overrides,
  }
}

function controlResult(overrides: Record<string, unknown> = {}) {
  return {
    ...controlStatus({ service: 'ok' }),
    summary: 'control lifecycle complete',
    ...overrides,
  }
}

async function openControl(app: App): Promise<View> {
  const menu = new MenuView({} as never, 'zone-1')
  await menu.onKey('c', { app, size: { rows: 25, cols: 100 }, status: '' })
  return latest<View>(app)
}

function text(view: View, app: App): string {
  return view.render({ app, size: { rows: 25, cols: 120 }, status: '' }).join('\n').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

beforeEach(() => {
  vi.clearAllMocks()
  engineMocks.resolveStackPaths.mockReturnValue({
    mode: 'dev',
    secretsDir: '/tmp/caracal-secrets',
  })
  engineMocks.readControlState.mockReturnValue({ mounted: true, enabled: true })
  engineMocks.controlServiceStatus.mockResolvedValue(controlStatus())
  engineMocks.applyControlLifecycleAction.mockImplementation(async ({ onLine }) => {
    onLine('mounting', 'stdout')
    onLine('ready', 'stdout')
    return controlResult({ state: 'enabled', mounted: true, enabled: true })
  })
  engineMocks.controlKeyList.mockResolvedValue([{ name: 'PiperNet automation', client_id: 'control-client-1' }])
  engineMocks.controlKeyGet.mockResolvedValue({
    client_id: 'control-client-1',
    allowed_scopes: ['control:read', 'control:write'],
    max_ttl_seconds: 600,
    restrictions: ['zone-bound'],
  })
  engineMocks.controlKeyCreate.mockResolvedValue({
    name: 'PiperNet automation',
    clientId: 'control-client-1',
    clientSecret: 'secret-once',
    resource: { identifier: 'resource://control' },
    allowedScopes: ['control:read', 'control:write'],
    maxTtlSeconds: 600,
    expiresAt: '2026-06-09T00:00:00.000Z',
  })
  engineMocks.controlKeyRotate.mockResolvedValue({ clientId: 'control-client-1', clientSecret: 'rotated-secret' })
  engineMocks.controlKeyRevoke.mockResolvedValue(undefined)
  engineMocks.credentialRead.mockResolvedValue('control-token')
})

describe('Control menu views', () => {
  it('initializes status, reloads errors, and supports back navigation', async () => {
    const app = fakeApp()
    const control = await openControl(app)
    await control.init?.(app)
    expect(text(control, app)).toContain('disable endpoint')

    await control.onKey('s', { app, size: { rows: 25, cols: 120 }, status: '' })
    const status = latest<View>(app)
    await status.init?.(app)
    expect(text(status, app)).toContain('Control API management')
    expect(text(status, app)).toContain('https://control.pipernet.example')

    engineMocks.controlServiceStatus.mockRejectedValueOnce(new Error('control down'))
    await status.onKey('r', { app, size: { rows: 25, cols: 120 }, status: '' })
    expect(text(status, app)).toContain('control down')

    status.onKey('esc', { app, size: { rows: 25, cols: 120 }, status: '' })
    expect(app.pop).toHaveBeenCalled()
  })

  it('surfaces Control init authorization failures', async () => {
    const app = fakeApp()
    const control = await openControl(app)
    engineMocks.authorizeControlManagementAccess.mockImplementationOnce(() => { throw new Error('not allowed') })

    await control.init?.(app)

    expect(app.setStatus).toHaveBeenCalledWith('control status: not allowed', 'error')
  })

  it('confirms and renders lifecycle output including captured runtime events', async () => {
    const app = fakeApp()
    const control = await openControl(app)

    await control.onKey('m', { app, size: { rows: 25, cols: 120 }, status: '' })
    const confirm = latest<View>(app)
    expect(text(confirm, app)).toContain('Confirm Control unmount')
    await confirm.onKey('y', { app, size: { rows: 25, cols: 120 }, status: '' })
    const lifecycle = latest<View>(app)
    await lifecycle.init?.(app)

    const rendered = text(lifecycle, app)
    expect(rendered).toContain('Control API management')
    expect(rendered).toContain('2 runtime lines captured')
    expect(app.setStatus).toHaveBeenCalledWith('control lifecycle complete')
    lifecycle.onKey('esc', { app, size: { rows: 25, cols: 120 }, status: '' })
    expect(app.pop).toHaveBeenCalled()
  })

  it('renders lifecycle errors when engine actions fail', async () => {
    const app = fakeApp()
    const control = await openControl(app)
    engineMocks.applyControlLifecycleAction.mockRejectedValueOnce(new Error('compose failed'))

    await control.onKey('e', { app, size: { rows: 25, cols: 120 }, status: '' })
    const confirm = latest<View>(app)
    await confirm.onKey('y', { app, size: { rows: 25, cols: 120 }, status: '' })
    const lifecycle = latest<View>(app)
    await lifecycle.init?.(app)

    expect(text(lifecycle, app)).toContain('compose failed')
    expect(app.setStatus).toHaveBeenCalledWith('control disable: compose failed', 'error')
  })

  it('submits create, get, rotate, revoke, and token forms with deterministic values', async () => {
    const app = fakeApp()
    const control = await openControl(app)
    const ctx = { app, size: { rows: 25, cols: 120 }, status: '' }

    await control.onKey('c', ctx)
    const create = latest<View>(app)
    Object.assign((create as unknown as { values_: () => Record<string, string> }).values_(), {
      name: 'PiperNet automation',
      scopes: 'control:read, control:write',
      max_ttl_seconds: '600',
      expires_in_days: '7',
    })
    ;(create as unknown as { focus: number }).focus = 4
    await create.onKey('enter', ctx)
    expect(engineMocks.controlKeyCreate).toHaveBeenCalledWith(expect.anything(), 'zone-1', expect.objectContaining({
      name: 'PiperNet automation',
      scopes: ['control:read', 'control:write'],
      maxTtlSeconds: 600,
    }))

    await control.onKey('g', ctx)
    const get = latest<View>(app)
    ;(get as unknown as { values_: () => Record<string, string> }).values_().id = 'control-client-1'
    ;(get as unknown as { focus: number }).focus = 1
    await get.onKey('enter', ctx)
    expect(latest<{ title: string }>(app).title).toBe('control / control-client-1')

    await control.onKey('r', ctx)
    const rotate = latest<View>(app)
    ;(rotate as unknown as { values_: () => Record<string, string> }).values_().id = 'control-client-1'
    ;(rotate as unknown as { focus: number }).focus = 1
    await rotate.onKey('enter', ctx)
    expect(engineMocks.controlKeyRotate).toHaveBeenCalledWith(expect.anything(), 'zone-1', 'control-client-1')

    await control.onKey('v', ctx)
    const revoke = latest<View>(app)
    ;(revoke as unknown as { values_: () => Record<string, string> }).values_().id = 'control-client-1'
    ;(revoke as unknown as { focus: number }).focus = 1
    await revoke.onKey('enter', ctx)
    expect(engineMocks.controlKeyRevoke).toHaveBeenCalledWith(expect.anything(), 'zone-1', 'control-client-1')
    expect(app.setStatus).toHaveBeenCalledWith('revoked control key control-client-1')

    await control.onKey('t', ctx)
    const token = latest<View>(app)
    Object.assign((token as unknown as { values_: () => Record<string, string> }).values_(), {
      id: 'control-client-1',
      client_secret: 'secret-once',
      scopes: 'control:read',
      ttl_seconds: '300',
    })
    ;(token as unknown as { focus: number }).focus = 4
    await token.onKey('enter', ctx)
    expect(engineMocks.credentialRead).toHaveBeenCalledWith(expect.objectContaining({
      cfg: expect.objectContaining({
        zone_url: 'https://sts.pipernet.example',
        zone_id: 'zone-1',
        application_id: 'control-client-1',
        app_client_secret: 'secret-once',
      }),
      resource: 'resource://control',
      scopes: ['control:read'],
      ttlSeconds: 300,
    }))
  })

  it('validates Control token scope and ttl limits before issuing credentials', async () => {
    const app = fakeApp()
    const control = await openControl(app)
    const ctx = { app, size: { rows: 25, cols: 120 }, status: '' }

    await control.onKey('t', ctx)
    const token = latest<View>(app)
    Object.assign((token as unknown as { values_: () => Record<string, string> }).values_(), {
      id: 'control-client-1',
      client_secret: 'secret-once',
      scopes: 'control:admin',
      ttl_seconds: '300',
    })
    ;(token as unknown as { focus: number }).focus = 4
    await token.onKey('enter', ctx)
    expect(app.setStatus).toHaveBeenCalledWith('control key control-client-1 does not grant control:admin', 'error')

    ;(token as unknown as { submitting: boolean }).submitting = false
    Object.assign((token as unknown as { values_: () => Record<string, string> }).values_(), {
      scopes: 'control:read',
      ttl_seconds: '900',
    })
    await token.onKey('enter', ctx)
    expect(app.setStatus).toHaveBeenCalledWith('token TTL exceeds control key maximum of 600 seconds', 'error')
  })
})
