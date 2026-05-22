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
} from '../../../../apps/tui/src/views/factory.ts'
import { DetailView } from '../../../../apps/tui/src/views/detail.ts'
import { ConfirmView, FormView } from '../../../../apps/tui/src/views/form.ts'
import { ListView } from '../../../../apps/tui/src/views/list.ts'
import type { App } from '../../../../apps/tui/src/screen.ts'

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
    setRows(list, [{ id: 'z1', slug: 'sl', name: 'n', login_flow: 'p', dcr_enabled: false, pkce_required: true }])
    const app = fakeApp()
    const pushed = await pressKey(list, 'd', app) as ConfirmView
    expect(pushed).toBeInstanceOf(ConfirmView)
    await pushed.onKey('y', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.zones.delete).toHaveBeenCalledWith('z1')
  })
})

describe('applications actions', () => {
  it('masks secret-shaped fields in application details by default', async () => {
    const { client, ctx } = newCtx()
    client.applications.get.mockResolvedValueOnce({
      id: 'a1',
      name: 'app',
      client_secret: 'secret-value',
    })
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'a1', name: 'app', registration_method: 'managed', credential_type: 'token', traits: [] }])
    const app = fakeApp()

    await list.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const detail = pushed[pushed.length - 1] as DetailView
    await detail.init(app)
    const out = detail.render({ app, size: { rows: 20, cols: 80 }, status: '' }).join('\n')

    expect(out).toContain('••••')
    expect(out).not.toContain('secret-value')
  })

  it('n opens a low-friction application form with generated managed defaults', async () => {
    const { ctx } = newCtx()
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    const pushed = await pressKey(list, 'n', fakeApp()) as FormView
    const keys = (pushed as unknown as { fields: { key: string }[] }).fields.map((f) => f.key)
    expect(keys).toEqual(['name', 'credential_type', 'consent'])
  })

  it('D opens DCR FormView with CLI-equivalent fields and calls applications.dcr', async () => {
    const { client, ctx } = newCtx()
    const list = applicationsView(ctx as unknown as Parameters<typeof applicationsView>[0]) as ListView<unknown>
    setRows(list, [{ id: 'a1', name: 'app', registration_method: 'managed', credential_type: 'token', traits: [] }])
    const app = fakeApp()
    const pushed = await pressKey(list, 'D', app) as FormView
    expect(pushed).toBeInstanceOf(FormView)
    const keys = (pushed as unknown as { fields: { key: string }[] }).fields.map((f) => f.key)
    expect(keys).toEqual(['name', 'credential_type', 'traits', 'expires_in'])
    ;(pushed as unknown as { values: Record<string, string> }).values = {
      name: 'app',
      credential_type: 'password',
      traits: 'a,b',
      expires_in: '60',
    }
    ;(pushed as unknown as { focus: number }).focus = 4
    await pushed.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.applications.dcr).toHaveBeenCalledWith('z1', {
      name: 'app',
      credential_type: 'password',
      traits: ['a', 'b'],
      expires_in: 60,
    })
  })
})

describe('resources actions', () => {
  it('n opens FormView with identifier+scopes required', async () => {
    const { ctx } = newCtx()
    const list = resourcesView(ctx as unknown as Parameters<typeof resourcesView>[0]) as ListView<unknown>
    const pushed = await pressKey(list, 'n', fakeApp()) as FormView
    const keys = (pushed as unknown as { fields: { key: string; required?: boolean }[] }).fields
      .filter((f) => f.required).map((f) => f.key)
    expect(keys).toContain('identifier')
    expect(keys).toContain('scopes')
  })

  it('n includes gateway and provider fields matching resource CLI flags', async () => {
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

  it('n includes client_id matching provider CLI flags', async () => {
    const { ctx } = newCtx()
    const list = providersView(ctx as unknown as Parameters<typeof providersView>[0]) as ListView<unknown>
    const pushed = await pressKey(list, 'n', fakeApp()) as FormView
    const keys = (pushed as unknown as { fields: { key: string }[] }).fields.map((f) => f.key)
    expect(keys).toContain('client_id')
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
    expect(keys).toEqual(['file', 'content'])
  })

  it('c opens validate form and calls policies.validate', async () => {
    const { client, ctx } = newCtx()
    const list = policiesView(ctx as unknown as Parameters<typeof policiesView>[0]) as ListView<unknown>
    const app = fakeApp()
    const form = await pressKey(list, 'c', app) as FormView
    ;(form as unknown as { values: Record<string, string> }).values = {
      file: '',
      content: 'package caracal\nallow := true',
    }
    ;(form as unknown as { focus: number }).focus = 2
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
      input: '{"subject":"u1"}',
      input_file: '',
    }
    ;(form as unknown as { focus: number }).focus = 3
    await form.onKey('enter', { app, size: { rows: 20, cols: 80 }, status: '' })
    expect(client.policySets.simulate).toHaveBeenCalledWith('z1', 'ps1', 'v1', { subject: 'u1' })
    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    expect(pushed[pushed.length - 1]).toBeInstanceOf(DetailView)
  })
})

describe('grants actions', () => {
  it('n opens grant form with pickers for application and resource references', async () => {
    const { ctx } = newCtx()
    const list = grantsView(ctx as unknown as Parameters<typeof grantsView>[0]) as ListView<unknown>
    const form = await pressKey(list, 'n', fakeApp()) as FormView
    const fields = (form as unknown as { fields: { key: string; pick?: unknown }[] }).fields
    expect(typeof fields.find((f) => f.key === 'application_id')?.pick).toBe('function')
    expect(typeof fields.find((f) => f.key === 'resource_id')?.pick).toBe('function')
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
  it('f opens filters matching CLI session flags', async () => {
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
