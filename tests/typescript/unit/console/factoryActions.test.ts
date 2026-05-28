// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Per-resource ListView mutation actions wire the right form/confirm and call the AdminClient.

import { describe, it, expect, vi } from 'vitest'
import {
  agentsView,
  applicationsView,
  delegationsView,
  grantsView,
  policiesView,
  policySetsView,
  providersView,
  resourcesView,
  sessionsView,
  zonesView,
} from '../../../../apps/console/src/views/factory.ts'
import { DetailView } from '../../../../apps/console/src/views/detail.ts'
import { ChoiceConfirmView, ConfirmView, FormView } from '../../../../apps/console/src/views/form.ts'
import { ListView } from '../../../../apps/console/src/views/list.ts'
import type { App } from '../../../../apps/console/src/screen.ts'
import { AdminApiError } from '../../../../packages/admin/ts/src/errors.ts'

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

function makeClient() {
  return {
    zones: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      dcrStatus: vi.fn(async () => ({ id: 'z1', dcr_enabled: false, live_dcr_applications: 0 })),
      create: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
    },
    applications: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
      dcr: vi.fn(async () => ({})),
    },
    resources: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
    },
    providers: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
    },
    policies: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      validate: vi.fn(async () => ({ valid: true })),
      addVersion: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
    },
    policySets: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      addVersion: vi.fn(async () => ({})),
      activate: vi.fn(async () => ({})),
      simulate: vi.fn(async () => ({ decision: 'allow' })),
      delete: vi.fn(async () => undefined),
    },
    grants: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      revoke: vi.fn(async () => undefined),
    },
    sessions: { list: vi.fn(async () => []) },
    agents: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({})),
      children: vi.fn(async () => []),
      suspend: vi.fn(async () => ({ suspended: true })),
      resume: vi.fn(async () => ({ resumed: true })),
      terminate: vi.fn(async () => undefined),
    },
    delegations: {
      active: vi.fn(async () => ({ items: [] })),
      inbound: vi.fn(async () => []),
      outbound: vi.fn(async () => []),
      traverse: vi.fn(async () => []),
      revoke: vi.fn(async () => ({ revoked_edges: 0, affected_sessions: 0 })),
    },
    audit: { list: vi.fn(async () => []), byRequest: vi.fn(async () => ({})) },
  }
}

type Client = ReturnType<typeof makeClient>

function newCtx(): { client: Client; ctx: { client: Client; zoneId: string } } {
  const client = makeClient()
  return { client, ctx: { client, zoneId: 'z1' } }
}

async function pressKey(view: ListView<unknown>, key: string, app: App): Promise<unknown> {
  await view.onKey(key, { app, size: { rows: 20, cols: 80 }, status: '' })
  const pushed = (app as unknown as { _pushed: unknown[] })._pushed
  return pushed[pushed.length - 1]
}

function setRows(view: ListView<unknown>, rows: unknown[]): void {
  ;(view as unknown as { rows: unknown[]; loading: boolean }).rows = rows
  ;(view as unknown as { rows: unknown[]; loading: boolean }).loading = false
}

describe('zones actions', () => {
  it('renders only implemented zone settings', async () => {
    const { ctx } = newCtx()
    const list = zonesView(ctx as unknown as Parameters<typeof zonesView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'z1', slug: 'sl', name: 'n', dcr_enabled: false }])
    const app = fakeApp()
    const table = list.render({ app, size: { rows: 20, cols: 100 }, status: '' }).join('\n')
    expect(table).toContain('dynamic clients')
    expect(table).not.toContain('login_flow')
    expect(table).not.toContain('pkce')

    const form = await pressKey(list, 'e', app) as FormView
    const body = form.render({ app, size: { rows: 20, cols: 100 }, status: '' }).join('\n')
    expect(body).toContain('dynamic clients')
    expect(body).not.toContain('require PKCE')
    expect(body).not.toContain('login flow')
  })

  it('n opens a FormView; submit calls zones.create', async () => {
    const { client, ctx } = newCtx()
    const list = zonesView(ctx as unknown as Parameters<typeof zonesView>[0]) as ListView<unknown>
    const app = fakeApp()
    const pushed = await pressKey(list, 'n', app) as FormView
    expect(pushed).toBeInstanceOf(FormView)
    ;(pushed as unknown as { values: Record<string, string> }).values = { name: 'z' }
    ;(pushed as unknown as { focus: number }).focus = 1
    await pushed.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.zones.create).toHaveBeenCalled()
  })

  it('d on row opens ConfirmView; y calls zones.delete', async () => {
    const { client, ctx } = newCtx()
    const list = zonesView(ctx as unknown as Parameters<typeof zonesView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'z1', slug: 'sl', name: 'n', dcr_enabled: false }])
    const app = fakeApp()
    const pushed = await pressKey(list, 'd', app) as ConfirmView
    expect(pushed).toBeInstanceOf(ConfirmView)
    await pushed.onKey('y', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.zones.delete).toHaveBeenCalledWith('z1')
  })

  it('asks how to handle listed live DCR apps before disabling dynamic clients', async () => {
    const { client, ctx } = newCtx()
    client.applications.list.mockResolvedValueOnce([
      {
        id: 'app-dcr',
        zone_id: 'z1',
        name: 'spawned agent',
        registration_method: 'dcr',
        expires_at: '2999-01-01T00:00:00.000Z',
        created_at: '2026-05-28T00:00:00.000Z',
      },
    ])
    const list = zonesView(ctx as unknown as Parameters<typeof zonesView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'z1', slug: 'sl', name: 'n', dcr_enabled: true }])
    const app = fakeApp()
    const form = await pressKey(list, 'e', app) as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      name: 'n',
      slug: 'sl',
      dcr_enabled: 'false',
    }
    ;(form as unknown as { focus: number }).focus = 3

    const pending = form.onKey('enter', { app, size: { rows: 20, cols: 100 }, status: '' })
    await Promise.resolve()
    await Promise.resolve()
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const choice = pushed[pushed.length - 1] as ChoiceConfirmView
    expect(choice).toBeInstanceOf(ChoiceConfirmView)
    await choice.onKey('k', { app, size: { rows: 20, cols: 100 }, status: '' })
    await pending

    expect(client.zones.patch).toHaveBeenCalledOnce()
    expect(client.zones.patch).toHaveBeenCalledWith('z1', {
      name: 'n',
      slug: 'sl',
      dcr_enabled: false,
      dcr_shutdown: 'keep_live',
    })
  })

  it('can revoke live DCR apps left behind after dynamic clients are already disabled', async () => {
    const { client, ctx } = newCtx()
    client.applications.list.mockResolvedValueOnce([
      {
        id: 'app-dcr',
        zone_id: 'z1',
        name: 'spawned agent',
        registration_method: 'dcr',
        expires_at: '2999-01-01T00:00:00.000Z',
        created_at: '2026-05-28T00:00:00.000Z',
      },
    ])
    const list = zonesView(ctx as unknown as Parameters<typeof zonesView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'z1', slug: 'sl', name: 'n', dcr_enabled: false }])
    const app = fakeApp()
    const form = await pressKey(list, 'e', app) as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      name: 'n',
      slug: 'sl',
      dcr_enabled: 'false',
    }
    ;(form as unknown as { focus: number }).focus = 3

    const pending = form.onKey('enter', { app, size: { rows: 20, cols: 100 }, status: '' })
    await Promise.resolve()
    await Promise.resolve()
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const choice = pushed[pushed.length - 1] as ChoiceConfirmView
    expect(choice).toBeInstanceOf(ChoiceConfirmView)
    await choice.onKey('r', { app, size: { rows: 20, cols: 100 }, status: '' })
    await pending

    expect(client.zones.patch).toHaveBeenCalledWith('z1', {
      name: 'n',
      slug: 'sl',
      dcr_enabled: false,
      dcr_shutdown: 'revoke_live',
    })
  })

  it('asks how to handle live DCR apps when the API requires a shutdown choice', async () => {
    const { client, ctx } = newCtx()
    client.zones.patch.mockRejectedValueOnce(new AdminApiError(409, 'dcr_shutdown_required', {
      error: 'dcr_shutdown_required',
      live_dcr_applications: 2,
    }))
    const list = zonesView(ctx as unknown as Parameters<typeof zonesView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'z1', slug: 'sl', name: 'n', dcr_enabled: true }])
    const app = fakeApp()
    const form = await pressKey(list, 'e', app) as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      name: 'n',
      slug: 'sl',
      dcr_enabled: 'false',
    }
    ;(form as unknown as { focus: number }).focus = 3

    const pending = form.onKey('enter', { app, size: { rows: 20, cols: 100 }, status: '' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const choice = pushed[pushed.length - 1] as ChoiceConfirmView
    expect(choice).toBeInstanceOf(ChoiceConfirmView)
    await choice.onKey('r', { app, size: { rows: 20, cols: 100 }, status: '' })
    await pending

    expect(client.zones.dcrStatus).not.toHaveBeenCalled()
    expect(client.zones.patch).toHaveBeenNthCalledWith(1, 'z1', {
      name: 'n',
      slug: 'sl',
      dcr_enabled: false,
    })
    expect(client.zones.patch).toHaveBeenNthCalledWith(2, 'z1', {
      name: 'n',
      slug: 'sl',
      dcr_enabled: false,
      dcr_shutdown: 'revoke_live',
    })
  })
})

describe('applications actions', () => {
  it('masks secret-shaped fields in application details by default', async () => {
    const { client, ctx } = newCtx()
    client.applications.get.mockResolvedValueOnce({
      id: 'a1',
      name: 'app',
      credential_type: 'token',
      consent: 'required',
      traits: [],
      client_secret: 'secret-value',
    })
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'a1', name: 'app', registration_method: 'managed', traits: [] }])
    const app = fakeApp()

    await list.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const detail = pushed[pushed.length - 1] as DetailView
    await detail.init(app)
    const out = detail.render({ app, size: { rows: 20, cols: 80 }, status: '' }).join('\n')

    expect(out).toContain('••••')
    expect(out).not.toContain('secret-value')
    expect(out).not.toContain('Credential Type')
    expect(out).not.toContain('Consent')
    expect(out).not.toContain('Traits')
    expect(out).not.toContain('token')
  })

  it('does not render fixed application credential type in the list', () => {
    const { ctx } = newCtx()
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'a1', name: 'Son of Anton', registration_method: 'managed', traits: [] }])

    const out = list.render({ app: fakeApp(), size: { rows: 20, cols: 100 }, status: '' }).join('\n')

    expect(out).toContain('method')
    expect(out).not.toContain('cred')
    expect(out).not.toContain('token')
  })

  it('n opens a low-friction application form with generated managed defaults', async () => {
    const { ctx } = newCtx()
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    const pushed = await pressKey(list, 'n', fakeApp()) as FormView
    const keys = (pushed as unknown as { fields: { key: string }[] }).fields.map((f) => f.key)
    expect(keys).toEqual(['name', 'registration_method', 'expires_in'])
    expect(pushed.values_().registration_method).toBe('managed')
    const app = fakeApp()
    let body = pushed.render({ app, size: { rows: 20, cols: 100 }, status: '' }).join('\n')
    expect(body).toContain('registration method ↳')
    expect(body).toContain('[ managed ]')
    expect(body).not.toContain('client lifetime seconds')

    ;(pushed as unknown as { values: Record<string, string> }).values.registration_method = 'dcr'
    body = pushed.render({ app, size: { rows: 20, cols: 100 }, status: '' }).join('\n')
    expect(body).toContain('client lifetime seconds')
    expect(body).toContain('3600')
    expect(body).not.toContain('require consent')
    expect(body).not.toContain('traits')
  })

  it('application registration method help explains managed vs DCR use cases', async () => {
    const { ctx } = newCtx()
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    const app = fakeApp()
    const form = await pressKey(list, 'n', app) as FormView
    ;(form as unknown as { focus: number }).focus = 1

    await form.onKey('?', { app, size: { rows: 25, cols: 100 }, status: '' })

    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const info = pushed[pushed.length - 1] as { render: FormView['render'] }
    const help = info.render({ app, size: { rows: 25, cols: 100 }, status: '' }).join('\n')
    expect(help).toContain('known durable agents')
    expect(help).toContain('ephemeral agents')
    expect(help).toContain('Dynamic Client Registration')
  })

  it('client lifetime help explains DCR expiry instead of showing a name example', async () => {
    const { ctx } = newCtx()
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    const app = fakeApp()
    const form = await pressKey(list, 'n', app) as FormView
    ;(form as unknown as { values: Record<string, string> }).values.registration_method = 'dcr'
    ;(form as unknown as { focus: number }).focus = 2

    await form.onKey('?', { app, size: { rows: 25, cols: 100 }, status: '' })

    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const info = pushed[pushed.length - 1] as { render: FormView['render'] }
    const help = info.render({ app, size: { rows: 25, cols: 100 }, status: '' }).join('\n')
    expect(help).toContain('DCR client lifetime')
    expect(help).toContain('one hour')
    expect(help).toContain('Example')
    expect(help).toContain('3600')
    expect(help).toContain('expires_at')
    expect(help).not.toContain('Son of Anton')
  })

  it('creates managed applications with a generated confidential client secret', async () => {
    const { client, ctx } = newCtx()
    client.applications.create.mockResolvedValueOnce({
      id: 'app-1',
      zone_id: 'z1',
      name: 'runner',
      registration_method: 'managed',
      client_secret: 'cs_generated',
      traits: [],
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    const app = fakeApp()
    const form = await pressKey(list, 'n', app) as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      name: 'runner',
      registration_method: 'managed',
    }
    ;(form as unknown as { focus: number }).focus = 2

    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })

    expect(client.applications.create).toHaveBeenCalledWith('z1', expect.objectContaining({
      name: 'runner',
      registration_method: 'managed',
    }))
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
    await detail.init(app)
    const out = detail.render({ app, size: { rows: 20, cols: 80 }, status: '' }).join('\n')
    expect(out).toContain('client_secret')
    expect(out).toContain('••••')
  })

  it('edits application names without exposing credential internals', async () => {
    const { client, ctx } = newCtx()
    client.applications.patch.mockResolvedValueOnce({
      id: 'app-1',
      name: 'agent',
    })
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'app-1', name: 'agent', registration_method: 'managed', traits: [] }])
    const app = fakeApp()
    const form = await pressKey(list, 'e', app) as FormView
    const keys = (form as unknown as { fields: { key: string }[] }).fields.map((f) => f.key)
    expect(keys).toEqual(['name'])
    ;(form as unknown as { values: Record<string, string> }).values = {
      name: 'agent',
    }
    ;(form as unknown as { focus: number }).focus = 1

    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })

    expect(client.applications.patch).toHaveBeenCalledWith('z1', 'app-1', { name: 'agent' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    expect(pushed[pushed.length - 1]).toBe(form)
  })

  it('creates DCR applications from the unified application form', async () => {
    const { client, ctx } = newCtx()
    client.applications.dcr.mockResolvedValueOnce({
      id: 'app-1',
      zone_id: 'z1',
      name: 'app',
      registration_method: 'dcr',
      client_secret: 'cs_generated',
      expires_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    const app = fakeApp()
    const pushed = await pressKey(list, 'n', app) as FormView
    expect(pushed).toBeInstanceOf(FormView)
    ;(pushed as unknown as { values: Record<string, string> }).values = {
      name: 'app',
      registration_method: 'dcr',
      expires_in: '60',
    }
    ;(pushed as unknown as { focus: number }).focus = 3
    await pushed.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.applications.dcr).toHaveBeenCalledWith('z1', expect.objectContaining({
      name: 'app',
      expires_in: 60,
    }))
    expect(client.applications.create).not.toHaveBeenCalled()
    const detail = (app as unknown as { _pushed: unknown[] })._pushed.at(-1) as DetailView
    expect(detail).toBeInstanceOf(DetailView)
  })

  it('does not expose DCR as a separate applications footer action', () => {
    const { ctx } = newCtx()
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    setRows(list, [])
    const actions = list.footerActions().map((action) => action.label)
    expect(actions).toContain('new')
    expect(actions).not.toContain('dcr')
  })
})

describe('resources actions', () => {
  it('hides the Control API audience from generic resource management', async () => {
    const { client, ctx } = newCtx()
    client.resources.list.mockResolvedValueOnce([
      { id: 'res-control', identifier: 'caracal-control', name: 'Control API', scopes: ['control:agent:write'] },
      { id: 'res-demo', identifier: 'demo-api', name: 'Demo API', scopes: ['read'] },
    ])
    const list = resourcesView(ctx as unknown as Parameters<typeof resourcesView>[0]) as ListView<unknown>
    const app = fakeApp()

    await list.init(app)
    const body = list.render({ app, size: { rows: 20, cols: 100 }, status: '' }).join('\n')

    expect(body).toContain('demo-api')
    expect(body).toContain('Demo API')
    expect(body).not.toContain('res-demo')
    expect(body).not.toContain('caracal-control')
  })

  it('n opens FormView with name+scopes required and identifier advanced', async () => {
    const { ctx } = newCtx()
    const list = resourcesView(ctx as unknown as Parameters<typeof resourcesView>[0]) as ListView<unknown>
    const pushed = await pressKey(list, 'n', fakeApp()) as FormView
    const fields = (pushed as unknown as { fields: { key: string; required?: boolean; advanced?: boolean }[] }).fields
    const keys = fields
      .filter((f) => f.required).map((f) => f.key)
    expect(keys).toContain('name')
    expect(keys).toContain('scopes')
    expect(fields.find((f) => f.key === 'identifier')?.advanced).toBe(true)
  })

  it('n includes gateway and provider fields for resource creation', async () => {
    const { ctx } = newCtx()
    const list = resourcesView(ctx as unknown as Parameters<typeof resourcesView>[0]) as ListView<unknown>
    const pushed = await pressKey(list, 'n', fakeApp()) as FormView
    const fields = (pushed as unknown as { fields: { key: string; pick?: unknown }[] }).fields
    const keys = fields.map((f) => f.key)
    expect(keys).toContain('gateway_application_id')
    expect(keys).toContain('credential_provider_id')
    expect(typeof fields.find((f) => f.key === 'gateway_application_id')?.pick).toBe('function')
    expect(typeof fields.find((f) => f.key === 'credential_provider_id')?.pick).toBe('function')
  })

  it('adapts resource fields to direct versus Gateway mode', async () => {
    const { ctx } = newCtx()
    const list = resourcesView(ctx as unknown as Parameters<typeof resourcesView>[0]) as ListView<unknown>
    const app = fakeApp()
    const form = await pressKey(list, 'n', app) as FormView
    const ctxView = { app, size: { rows: 30, cols: 100 }, status: '' }

    expect(form.render(ctxView).join('\n')).not.toContain('upstream URL *')
    ;(form as unknown as { values: Record<string, string> }).values.mode = 'gateway'
    let body = form.render(ctxView).join('\n')
    expect(body).toContain('upstream URL *')
    expect(body).toContain('Advanced options')

    ;(form as unknown as { focus: number }).focus = 4
    await form.onKey('right', ctxView)
    const advanced = (app as unknown as { _pushed: unknown[] })._pushed.at(-1) as FormView
    body = advanced.render(ctxView).join('\n')
    expect(body).toContain('gateway app')
    expect(body).toContain('credential provider')
  })
})

describe('providers actions', () => {
  it('n opens FormView with config_json multiline', async () => {
    const { ctx } = newCtx()
    const list = providersView(ctx as unknown as Parameters<typeof providersView>[0]) as ListView<unknown>
    const pushed = await pressKey(list, 'n', fakeApp()) as FormView
    const fields = (pushed as unknown as { fields: { key: string; kind: string }[] }).fields
    expect(fields.find((f) => f.key === 'config_file')?.kind).toBe('file')
    expect(fields.find((f) => f.key === 'config_json')?.kind).toBe('multiline')
  })

  it('n includes client_id for provider creation', async () => {
    const { ctx } = newCtx()
    const list = providersView(ctx as unknown as Parameters<typeof providersView>[0]) as ListView<unknown>
    const pushed = await pressKey(list, 'n', fakeApp()) as FormView
    const keys = (pushed as unknown as { fields: { key: string }[] }).fields.map((f) => f.key)
    expect(keys).toContain('client_id')
  })

  it('adapts provider fields to the selected provider kind', async () => {
    const { ctx } = newCtx()
    const list = providersView(ctx as unknown as Parameters<typeof providersView>[0]) as ListView<unknown>
    const form = await pressKey(list, 'n', fakeApp()) as FormView
    const ctxView = { app: fakeApp(), size: { rows: 30, cols: 100 }, status: '' }

    let body = form.render(ctxView).join('\n')
    expect(body).toContain('issuer')
    expect(body).toContain('authorization endpoint')
    expect(body).toContain('token endpoint *')
    expect(body).not.toContain('API key header')
    expect(body).not.toContain('audience *')

    ;(form as unknown as { values: Record<string, string> }).values.kind = 'apikey'
    body = form.render(ctxView).join('\n')
    expect(body).toContain('API key header *')
    expect(body).not.toContain('issuer')
    expect(body).not.toContain('authorization endpoint')
    expect(body).not.toContain('token endpoint *')
    expect(body).not.toContain('audience *')

    ;(form as unknown as { values: Record<string, string> }).values.kind = 'workload'
    body = form.render(ctxView).join('\n')
    expect(body).toContain('issuer *')
    expect(body).toContain('audience *')
    expect(body).toContain('token endpoint *')
    expect(body).not.toContain('API key header')
    expect(body).not.toContain('authorization endpoint')
  })

  it('creates oauth providers with upstream OAuth scopes separated from Caracal scopes', async () => {
    const { client, ctx } = newCtx()
    const list = providersView(ctx as unknown as Parameters<typeof providersView>[0]) as ListView<unknown>
    const app = fakeApp()
    const pushed = await pressKey(list, 'n', app) as FormView
    ;(pushed as unknown as { values: Record<string, string> }).values = {
      identifier: 'provider-id',
      name: 'GitHub OAuth',
      kind: 'oauth2',
      client_id: 'client-id',
      issuer: '',
      authorization_endpoint: '',
      token_endpoint: 'https://provider.example/token',
      allowed_token_hosts: 'provider.example',
      upstream_oauth_scopes: 'provider.scope',
      api_key_header: '',
      auth_scheme: '',
      workload_audience: '',
      workload_token_endpoint: '',
      workload_allowed_token_hosts: '',
      forward_caracal_identity: 'false',
      config_file: '',
      config_json: '',
    }
    ;(pushed as unknown as { focus: number }).focus = 99

    await pushed.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })

    expect(client.providers.create).toHaveBeenCalledWith('z1', expect.objectContaining({
      identifier: 'provider-id',
      kind: 'oauth2',
      client_id: 'client-id',
      config_json: {
        token_endpoint: 'https://provider.example/token',
        allowed_token_hosts: ['provider.example'],
        upstream_oauth_scopes: ['provider.scope'],
      },
    }))
  })

  it('drops stale hidden provider fields when the provider kind changes', async () => {
    const { client, ctx } = newCtx()
    const list = providersView(ctx as unknown as Parameters<typeof providersView>[0]) as ListView<unknown>
    const app = fakeApp()
    const pushed = await pressKey(list, 'n', app) as FormView
    ;(pushed as unknown as { values: Record<string, string> }).values = {
      identifier: 'provider-id',
      name: 'API key provider',
      kind: 'apikey',
      client_id: 'stale-client',
      issuer: 'https://issuer.example.com',
      authorization_endpoint: 'https://issuer.example.com/auth',
      token_endpoint: 'https://provider.example/token',
      allowed_token_hosts: 'provider.example',
      upstream_oauth_scopes: 'provider.scope',
      api_key_header: 'X-Api-Key',
      auth_scheme: '',
      workload_audience: 'stale-audience',
      workload_token_endpoint: 'https://workload.example/token',
      workload_allowed_token_hosts: 'workload.example',
      forward_caracal_identity: 'false',
      config_file: '',
      config_json: '',
    }
    ;(pushed as unknown as { focus: number }).focus = 99

    await pushed.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })

    expect(client.providers.create).toHaveBeenCalledWith('z1', expect.objectContaining({
      identifier: 'provider-id',
      kind: 'apikey',
      config_json: {
        header_name: 'X-Api-Key',
      },
    }))
  })

  it('rejects provider config that mixes upstream scopes with Caracal scopes', async () => {
    const { client, ctx } = newCtx()
    const list = providersView(ctx as unknown as Parameters<typeof providersView>[0]) as ListView<unknown>
    const app = fakeApp()
    const pushed = await pressKey(list, 'n', app) as FormView
    ;(pushed as unknown as { values: Record<string, string> }).values = {
      identifier: 'provider-id',
      name: 'GitHub OAuth',
      kind: 'oauth2',
      client_id: '',
      issuer: '',
      authorization_endpoint: '',
      token_endpoint: 'https://provider.example/token',
      allowed_token_hosts: 'provider.example',
      upstream_oauth_scopes: '',
      api_key_header: '',
      auth_scheme: '',
      workload_audience: '',
      workload_token_endpoint: '',
      workload_allowed_token_hosts: '',
      forward_caracal_identity: 'false',
      config_file: '',
      config_json: '{"scopes":["provider.scope"]}',
    }
    ;(pushed as unknown as { focus: number }).focus = 99

    await pushed.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })

    expect(client.providers.create).not.toHaveBeenCalled()
    expect(app.setStatus).toHaveBeenCalledWith(expect.stringContaining('upstream_oauth_scopes'), 'error')
  })
})

describe('policies actions', () => {
  it('v on row opens FormView for policy version', async () => {
    const { ctx } = newCtx()
    const list = policiesView(ctx as unknown as Parameters<typeof policiesView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'p1', name: 'pol', owner_type: 'admin', description: null }])
    const pushed = await pressKey(list, 'v', fakeApp()) as FormView
    expect(pushed).toBeInstanceOf(FormView)
    const keys = (pushed as unknown as { fields: { key: string }[] }).fields.map((f) => f.key)
    expect(keys).toEqual(['source', 'content', 'file'])
  })

  it('c opens validate form and calls policies.validate', async () => {
    const { client, ctx } = newCtx()
    const list = policiesView(ctx as unknown as Parameters<typeof policiesView>[0]) as ListView<unknown>
    const app = fakeApp()
    const form = await pressKey(list, 'c', app) as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      source: 'paste',
      file: '',
      content: 'package caracal\nallow := true',
    }
    ;(form as unknown as { focus: number }).focus = 3
    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.policies.validate).toHaveBeenCalledWith('package caracal\nallow := true')
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    expect(pushed[pushed.length - 1]).toBeInstanceOf(DetailView)
  })
})

describe('policySets actions', () => {
  it('a on row opens FormView for activate', async () => {
    const { ctx } = newCtx()
    const list = policySetsView(ctx as unknown as Parameters<typeof policySetsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'ps1', name: 'ps', description: null, active_version_id: null }])
    const pushed = await pressKey(list, 'a', fakeApp()) as FormView
    const keys = (pushed as unknown as { fields: { key: string }[] }).fields.map((f) => f.key)
    expect(keys).toEqual(['version_id', 'shadow_version_id'])
  })

  it('s on row simulates a policy-set version with JSON input', async () => {
    const { client, ctx } = newCtx()
    const list = policySetsView(ctx as unknown as Parameters<typeof policySetsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'ps1', name: 'ps', description: null, active_version_id: null }])
    const app = fakeApp()
    const form = await pressKey(list, 's', app) as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      version_id: 'v1',
      source: 'paste',
      input: '{"subject":"u1"}',
      input_file: '',
    }
    ;(form as unknown as { focus: number }).focus = 4
    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.policySets.simulate).toHaveBeenCalledWith('z1', 'ps1', 'v1', { subject: 'u1' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    expect(pushed[pushed.length - 1]).toBeInstanceOf(DetailView)
  })

  it('adapts policy-set simulation input to the selected source', async () => {
    const { ctx } = newCtx()
    const list = policySetsView(ctx as unknown as Parameters<typeof policySetsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'ps1', name: 'ps', description: null, active_version_id: null }])
    const form = await pressKey(list, 's', fakeApp()) as FormView
    const ctxView = { app: fakeApp(), size: { rows: 20, cols: 100 }, status: '' }

    let body = form.render(ctxView).join('\n')
    expect(body).not.toContain('inline input')
    expect(body).not.toContain('input file')

    ;(form as unknown as { values: Record<string, string> }).values.source = 'paste'
    body = form.render(ctxView).join('\n')
    expect(body).toContain('inline input *')
    expect(body).not.toContain('input file')

    ;(form as unknown as { values: Record<string, string> }).values.source = 'file'
    body = form.render(ctxView).join('\n')
    expect(body).toContain('input file *')
    expect(body).not.toContain('inline input')
  })
})

describe('grants actions', () => {
  it('renders application and resource names instead of internal IDs', async () => {
    const { client, ctx } = newCtx()
    client.grants.list.mockResolvedValueOnce([
      { id: 'g1', application_id: 'app-1', user_id: 'u', resource_id: 'res-1', scopes: ['read'], status: 'active' },
    ])
    client.applications.list.mockResolvedValueOnce([
      { id: 'app-1', name: 'GitHub OAuth Client', registration_method: 'managed', traits: [] },
    ])
    client.resources.list.mockResolvedValueOnce([
      { id: 'res-1', identifier: 'payments', name: 'Payments API', scopes: ['read'] },
    ])
    const list = grantsView(ctx as unknown as Parameters<typeof grantsView>[0]) as ListView<unknown>
    const app = fakeApp()

    await list.init(app)
    const body = list.render({ app, size: { rows: 20, cols: 120 }, status: '' }).join('\n')

    expect(body).toContain('GitHub OAuth Client')
    expect(body).toContain('Payments API')
    expect(body).not.toContain('app-1')
    expect(body).not.toContain('res-1')
  })

  it('n opens grant form with pickers for application and resource references', async () => {
    const { ctx } = newCtx()
    const list = grantsView(ctx as unknown as Parameters<typeof grantsView>[0]) as ListView<unknown>
    const form = await pressKey(list, 'n', fakeApp()) as FormView
    const fields = (form as unknown as { fields: { key: string; pick?: unknown }[] }).fields
    expect(typeof fields.find((f) => f.key === 'application_id')?.pick).toBe('function')
    expect(typeof fields.find((f) => f.key === 'resource_id')?.pick).toBe('function')
  })

  it('shows grant scopes only after a resource is selected', async () => {
    const { ctx } = newCtx()
    const list = grantsView(ctx as unknown as Parameters<typeof grantsView>[0]) as ListView<unknown>
    const form = await pressKey(list, 'n', fakeApp()) as FormView
    const ctxView = { app: fakeApp(), size: { rows: 20, cols: 100 }, status: '' }

    expect(form.render(ctxView).join('\n')).not.toContain('Caracal scopes')
    ;(form as unknown as { values: Record<string, string> }).values.resource_id = 'res-1'
    expect(form.render(ctxView).join('\n')).toContain('Caracal scopes *')
  })

  it('k revokes selected grant', async () => {
    const { client, ctx } = newCtx()
    const list = grantsView(ctx as unknown as Parameters<typeof grantsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'g1', application_id: 'a', user_id: 'u', resource_id: 'r', scopes: [], status: 'active' }])
    const app = fakeApp()
    const pushed = await pressKey(list, 'k', app) as ConfirmView
    await pushed.onKey('y', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.grants.revoke).toHaveBeenCalledWith('z1', 'g1')
  })
})

describe('agents actions', () => {
  it('loads agents from the Coordinator without requiring application lookups', async () => {
    const { client, ctx } = newCtx()
    client.agents.list.mockResolvedValueOnce([{
      agent_session_id: 'ag1',
      zone_id: 'z1',
      application_id: 'app1',
      parent_id: null,
      subject_session_id: 'subject1',
      status: 'active',
      depth: 0,
      spawned_at: 'now',
      terminated_at: null,
    }])
    client.applications.list.mockRejectedValueOnce(new Error('api unavailable'))
    const list = agentsView(ctx as unknown as Parameters<typeof agentsView>[0]) as ListView<unknown>

    await list.init(fakeApp())
    const lines = list.render({ app: fakeApp(), size: { rows: 20, cols: 80 }, status: '' })

    expect(lines.join('\n')).toContain('app1')
    expect(client.applications.list).not.toHaveBeenCalled()
  })

  it('s/r/t open ConfirmView for suspend/resume/terminate', async () => {
    const cases = [
      ['s', 'suspend'],
      ['r', 'resume'],
      ['t', 'terminate'],
    ] as const
    for (const [key, fn] of cases) {
      const { client, ctx } = newCtx()
      const list = agentsView(ctx as unknown as Parameters<typeof agentsView>[0]) as ListView<unknown>
      setRows(list, [{ agent_session_id: 'ag1', application_id: 'a', parent_id: null, status: 'active', depth: 0, spawned_at: 'now' }])
      const app = fakeApp()
      const pushed = await pressKey(list, key, app) as ConfirmView
      expect(pushed).toBeInstanceOf(ConfirmView)
      await pushed.onKey('y', { app, size: { rows: 20, cols: 80 }, status: '' })
      expect(client.agents[fn]).toHaveBeenCalledWith('z1', 'ag1')
    }
  })

  it('T opens DetailView calling agents.children', async () => {
    const { ctx } = newCtx()
    const list = agentsView(ctx as unknown as Parameters<typeof agentsView>[0]) as ListView<unknown>
    setRows(list, [{ agent_session_id: 'ag1', application_id: 'a', parent_id: null, status: 'active', depth: 0, spawned_at: 'now' }])
    const pushed = await pressKey(list, 'T', fakeApp()) as { title: string }
    expect(pushed.title).toContain('agent-tree')
  })
})

describe('sessions actions', () => {
  it('f opens session filters', async () => {
    const { client, ctx } = newCtx()
    const list = sessionsView(ctx as unknown as Parameters<typeof sessionsView>[0]) as ListView<unknown>
    const app = fakeApp()
    const form = await pressKey(list, 'f', app) as FormView
    expect(form).toBeInstanceOf(FormView)
    ;(form as unknown as { values: Record<string, string> }).values = {
      status: 'active',
      subject_id: 'user-1',
      limit: '25',
    }
    ;(form as unknown as { focus: number }).focus = 3
    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.sessions.list).toHaveBeenCalledWith('z1', {
      status: 'active',
      subject_id: 'user-1',
      limit: 25,
    })
  })
})

describe('delegations actions', () => {
  it('opens inbound workflow and loads coordinator delegations', async () => {
    const { client, ctx } = newCtx()
    const menu = delegationsView(ctx as unknown as Parameters<typeof delegationsView>[0])
    const app = fakeApp()
    await menu.onKey('i', { app, size: { rows: 20, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const form = pushed[pushed.length - 1] as FormView
    expect(form).toBeInstanceOf(FormView)
    expect(typeof (form as unknown as { fields: { pick?: unknown }[] }).fields[0]?.pick).toBe('function')
    ;(form as unknown as { values: Record<string, string> }).values = { session_id: 's1' }
    ;(form as unknown as { focus: number }).focus = 1
    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    const list = pushed[pushed.length - 1] as ListView<unknown>
    await list.init(app)
    expect(client.delegations.inbound).toHaveBeenCalledWith('z1', 's1')
  })

  it('opens traverse workflow and loads chain nodes', async () => {
    const { client, ctx } = newCtx()
    const menu = delegationsView(ctx as unknown as Parameters<typeof delegationsView>[0])
    const app = fakeApp()
    await menu.onKey('t', { app, size: { rows: 20, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const form = pushed[pushed.length - 1] as FormView
    expect(typeof (form as unknown as { fields: { pick?: unknown }[] }).fields[0]?.pick).toBe('function')
    ;(form as unknown as { values: Record<string, string> }).values = { edge_id: 'e1' }
    ;(form as unknown as { focus: number }).focus = 1
    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    const list = pushed[pushed.length - 1] as ListView<unknown>
    await list.init(app)
    expect(client.delegations.traverse).toHaveBeenCalledWith('z1', 'e1')
  })

  it('opens revoke workflow and shows revoke result detail', async () => {
    const { client, ctx } = newCtx()
    const menu = delegationsView(ctx as unknown as Parameters<typeof delegationsView>[0])
    const app = fakeApp()
    await menu.onKey('r', { app, size: { rows: 20, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const form = pushed[pushed.length - 1] as FormView
    ;(form as unknown as { values: Record<string, string> }).values = { edge_id: 'e1' }
    ;(form as unknown as { focus: number }).focus = 1
    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.delegations.revoke).toHaveBeenCalledWith('z1', 'e1')
    expect(pushed[pushed.length - 1]).toBeInstanceOf(DetailView)
  })

  it('does not expose removed impact action', async () => {
    const { ctx } = newCtx()
    const menu = delegationsView(ctx as unknown as Parameters<typeof delegationsView>[0])
    const app = fakeApp()
    await menu.onKey('b', { app, size: { rows: 20, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    expect(pushed).toHaveLength(0)
  })
})
