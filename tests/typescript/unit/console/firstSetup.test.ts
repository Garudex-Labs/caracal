// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// First setup wizard tests for guided onboarding and generated runtime output.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { firstSetupView } from '../../../../apps/console/src/views/setup.ts'
import { DetailView } from '../../../../apps/console/src/views/detail.ts'
import { FormView } from '../../../../apps/console/src/views/form.ts'
import type { App, View, ViewContext } from '../../../../apps/console/src/screen.ts'

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
  const zone = { id: 'zone-1', slug: 'zone-slug', name: 'zone-name' }
  const application = {
    id: 'app-1',
    zone_id: 'zone-1',
    name: 'agent-app-name',
    registration_method: 'managed',
    credential_type: 'token',
    traits: [],
    consent: 'false',
    created_at: '2026-01-01T00:00:00.000Z',
  }
  const resource = {
    id: 'res-1',
    zone_id: 'zone-1',
    name: 'resource-name',
    identifier: 'resource://resource-name',
    upstream_url: 'https://upstream-url',
    gateway_application_id: 'app-1',
    prefix: true,
    scopes: ['scope-name'],
    credential_provider_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
  const provider = {
    id: 'provider-1',
    zone_id: 'zone-1',
    name: 'provider-name',
    identifier: 'provider://provider-name',
    kind: 'oauth2',
    owner_type: 'customer',
    client_id: null,
    config_json: {
      token_endpoint: 'https://issuer.example.com/oauth/token',
      allowed_token_hosts: ['issuer.example.com'],
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
  return {
    zones: {
      list: vi.fn(async () => [zone]),
      get: vi.fn(async () => zone),
      create: vi.fn(async () => zone),
    },
    applications: {
      list: vi.fn(async () => [application]),
      get: vi.fn(async () => application),
      create: vi.fn(async () => application),
    },
    resources: {
      list: vi.fn(async () => [resource]),
      get: vi.fn(async () => resource),
      create: vi.fn(async (_zoneId: string, input: Partial<typeof resource>) => ({
        ...resource,
        ...input,
        upstream_url: input.upstream_url ?? null,
        gateway_application_id: input.gateway_application_id ?? null,
      })),
      patch: vi.fn(async (_zoneId: string, _id: string, patch: Partial<typeof resource>) => ({ ...resource, ...patch })),
    },
    providers: {
      list: vi.fn(async () => [provider]),
      get: vi.fn(async () => provider),
      create: vi.fn(async (_zoneId: string, input: Partial<typeof provider>) => ({ ...provider, ...input })),
    },
    policies: {
      create: vi.fn(async () => ({
        id: 'pol-1',
        zone_id: 'zone-1',
        name: 'Guided setup access policy',
        description: '',
        owner_type: 'system',
        created_by: 'console',
        created_at: '2026-01-01T00:00:00.000Z',
        version: {
          id: 'pv-1',
          policy_id: 'pol-1',
          version: 1,
          content_sha256: 'sha',
          schema_version: 'v1',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      })),
    },
    policySets: {
      create: vi.fn(async () => ({ id: 'ps-1', zone_id: 'zone-1', name: 'Guided setup access policy set', created_at: '2026-01-01T00:00:00.000Z' })),
      addVersion: vi.fn(async () => ({ id: 'psv-1', policy_set_id: 'ps-1', version: 1, manifest: [], created_at: '2026-01-01T00:00:00.000Z' })),
      activate: vi.fn(async () => ({ active_version_id: 'psv-1' })),
    },
  }
}

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'caracal-first-setup-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function ctx(app: App): ViewContext {
  return { app, size: { rows: 80, cols: 140 }, status: '' }
}

function latestForm(app: App): FormView {
  const form = (app as unknown as { _pushed: unknown[] })._pushed.at(-1)
  expect(form).toBeInstanceOf(FormView)
  return form as FormView
}

async function submitLatestForm(app: App, values: Record<string, string>): Promise<void> {
  const form = latestForm(app)
  Object.assign(form.values_(), values)
  await (form as unknown as { trySubmit: (app: App) => Promise<void> }).trySubmit(app)
}

async function openAndSubmit(view: View, app: App, values: Record<string, string>): Promise<void> {
  await view.onKey('enter', ctx(app))
  await submitLatestForm(app, values)
}

async function completeMainPath(view: View, app: App): Promise<void> {
  await openAndSubmit(view, app, { zone_name: 'zone-name' })
  await openAndSubmit(view, app, { agent_app_name: 'agent-app-name' })
  await openAndSubmit(view, app, { provider_mode: 'none' })
  await openAndSubmit(view, app, { resource_name: 'resource-name', resource_scopes: 'scope-name' })
  await openAndSubmit(view, app, { policy_mode: 'create' })
  await view.onKey('enter', ctx(app))
}

describe('first setup workflow', () => {
  it('shows guided object pages and keeps advanced fields out of the overview', async () => {
    const app = fakeApp()
    const view = firstSetupView({
      client: makeClient() as never,
      zoneId: 'zone-1',
    })
    await view.init?.(app)

    const body = view.render(ctx(app)).join('\n')
    expect(body).toContain('Step 1')
    expect(body).toContain('Agent app')
    expect(body).toContain('Provider')
    expect(body).toContain('Access policy')
    expect(body.indexOf('Provider')).toBeLessThan(body.indexOf('Resource'))
    expect(body.indexOf('Resource')).toBeLessThan(body.indexOf('Access policy'))
    expect(body).not.toContain('Choose or create a zone')
    expect(body).not.toContain('resource identifier')
    expect(body).not.toContain('profile path')

    await view.onKey('enter', ctx(app))
    const appForm = latestForm(app)
    const appBody = appForm.render(ctx(app)).join('\n')
    expect(appBody).toContain('guided setup / agent app')
    expect(appBody).toContain('app action')
    expect(appBody).toContain('app name')

    await view.onKey('A', ctx(app))
    const advanced = (app as unknown as { _pushed: unknown[] })._pushed.at(-1) as FormView
    expect(advanced).toBeInstanceOf(FormView)
    const advancedBody = advanced.render(ctx(app)).join('\n')
    expect(advancedBody).toContain('profile path')
    expect(advancedBody).not.toContain('resource identifier')
    expect(advancedBody).not.toContain('provider identifier')
  })

  it('creates the first zone, app, resource, policy, and generated profile from sequential answers', async () => {
    const client = makeClient()
    const selected: string[] = []
    const app = fakeApp()
    const view = firstSetupView({
      client: client as never,
      zoneId: undefined,
      onZoneSelect: (id) => { selected.push(id) },
    } as never)

    await completeMainPath(view, app)

    expect(client.zones.create).toHaveBeenCalledWith({ name: 'zone-name' })
    expect(selected).toEqual(['zone-1'])
    expect(client.applications.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      name: 'agent-app-name',
      registration_method: 'managed',
      credential_type: 'token',
      client_secret: expect.stringMatching(/^cs_[A-Za-z0-9_-]+$/),
    }))
    expect(client.resources.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      identifier: 'resource://resource-name',
      name: 'resource-name',
      upstream_url: undefined,
      gateway_application_id: undefined,
      scopes: ['scope-name'],
    }))
    expect(client.policies.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      name: 'Guided setup access policy',
      content: expect.stringContaining('input.principal.id == "app-1"'),
    }))
    expect(client.policySets.activate).toHaveBeenCalledWith('zone-1', 'ps-1', 'psv-1')

    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
    await detail.init(app)
    const body = detail.render(ctx(app)).join('\n')
    expect(body).toContain('created')
    expect(body).toContain('CARACAL_RESOURCE_RESOURCE_NAME_TOKEN')
    expect(body).toContain('caracal run --')
    expect(body).toContain('Gateway routing was not configured')
    expect(body).toContain('Audit Explanation')
    expect(body).toContain('starter least-privilege allow-list')
    expect(body).toContain('Denies by default')
    expect(body).toContain('••••')
    expect(body).not.toContain('cs_')
    expect(body).not.toContain('zone_url')
    expect(body).not.toContain('application_id')
    expect(body).not.toContain('Policy ID')
    expect(body).not.toContain('Policy Version ID')
    expect(body).not.toContain('Policy Set ID')
    expect(body).not.toContain('Content')
    expect(body).not.toContain('Local Profile Setup')
    expect(body).not.toContain('Powershell')
  })

  it('adds provider setup to the guided Gateway path and links the resource to the provider', async () => {
    const client = makeClient()
    const app = fakeApp()
    const view = firstSetupView({
      client: client as never,
      zoneId: 'zone-1',
    })
    await view.init?.(app)

    await openAndSubmit(view, app, { agent_app_name: 'agent-app-name' })
    await openAndSubmit(view, app, {
      provider_name: 'provider-name',
      provider_kind: 'oauth2',
      provider_token_endpoint: 'https://issuer.example.com/oauth/token',
    })
    await openAndSubmit(view, app, {
      resource_name: 'resource-name',
      resource_scopes: 'scope-name',
      upstream_url: 'https://api.example.com',
    })
    await openAndSubmit(view, app, { policy_mode: 'create' })
    await view.onKey('enter', ctx(app))

    expect(client.providers.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      identifier: 'provider://provider-name',
      name: 'provider-name',
      kind: 'oauth2',
      config_json: expect.objectContaining({
        token_endpoint: 'https://issuer.example.com/oauth/token',
        allowed_token_hosts: ['issuer.example.com'],
      }),
    }))
    expect(client.resources.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      upstream_url: 'https://api.example.com',
      gateway_application_id: 'app-1',
      credential_provider_id: 'provider-1',
      prefix: true,
    }))
  })

  it('selects existing objects without asking for their IDs in the main flow', async () => {
    const client = makeClient()
    const app = fakeApp()
    const view = firstSetupView({
      client: client as never,
      zoneId: 'zone-1',
    })
    await view.init?.(app)

    await openAndSubmit(view, app, { application_mode: 'select', selected_agent_app_id: 'app-1' })
    await openAndSubmit(view, app, { provider_mode: 'none' })
    await openAndSubmit(view, app, { resource_mode: 'select', selected_resource_id: 'res-1', resource_scopes: 'scope-name' })
    await openAndSubmit(view, app, { policy_mode: 'create' })
    await view.onKey('enter', ctx(app))

    expect(client.zones.create).not.toHaveBeenCalled()
    expect(client.applications.create).not.toHaveBeenCalled()
    expect(client.resources.create).not.toHaveBeenCalled()
    expect(client.resources.patch).not.toHaveBeenCalled()

    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const detail = pushed[pushed.length - 1] as DetailView
    await detail.init(app)
    const body = detail.render(ctx(app)).join('\n')
    expect(body).toContain('selected')
    expect(body).toContain('Existing app selected')
    expect(body).not.toContain('Client Secret          ••••')
  })

  it('lets optional policy and profile setup be skipped explicitly', async () => {
    const client = makeClient()
    const app = fakeApp()
    const view = firstSetupView({
      client: client as never,
      zoneId: 'zone-1',
    })
    await view.init?.(app)
    Object.assign((view as unknown as { values: Record<string, string> }).values, { generate_profile: 'false' })

    await openAndSubmit(view, app, { agent_app_name: 'agent-app-name' })
    await openAndSubmit(view, app, { provider_mode: 'none' })
    await openAndSubmit(view, app, { resource_name: 'resource-name', resource_scopes: 'scope-name' })
    await openAndSubmit(view, app, { policy_mode: 'skip' })
    await view.onKey('enter', ctx(app))

    expect(client.zones.create).not.toHaveBeenCalled()
    expect(client.resources.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      identifier: 'resource://resource-name',
      upstream_url: undefined,
      gateway_application_id: undefined,
      scopes: ['scope-name'],
    }))
    expect(client.policies.create).not.toHaveBeenCalled()
    expect(client.policySets.create).not.toHaveBeenCalled()
  })

  it('writes generated profile and secret files only when requested', async () => {
    const client = makeClient()
    const app = fakeApp()
    const dir = await tempDir()
    const profilePath = join(dir, 'setup-profile.toml')
    const secretPath = join(dir, 'setup-secret')
    const view = firstSetupView({
      client: client as never,
      zoneId: 'zone-1',
    })
    await view.init?.(app)
    Object.assign((view as unknown as { values: Record<string, string> }).values, {
      profile_path: profilePath,
      secret_file_path: secretPath,
      upstream_url: 'https://upstream-url',
      request_path: '/request-path',
      write_files: 'true',
    })

    await openAndSubmit(view, app, { agent_app_name: 'agent-app-name' })
    await openAndSubmit(view, app, { provider_mode: 'none' })
    await openAndSubmit(view, app, { resource_name: 'resource-name', resource_scopes: 'scope-name', upstream_url: 'https://upstream-url' })
    await openAndSubmit(view, app, { policy_mode: 'create' })
    await view.onKey('enter', ctx(app))

    const profile = await readFile(profilePath, 'utf8')
    const secret = await readFile(secretPath, 'utf8')
    expect(profile).toContain('application_id = "app-1"')
    expect(profile).toContain(`app_client_secret_file = ${JSON.stringify(secretPath)}`)
    expect(secret).toMatch(/^cs_[A-Za-z0-9_-]+\n$/)
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600)
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600)

    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const detail = pushed[pushed.length - 1] as DetailView
    await detail.init(app)
    const body = detail.render(ctx(app)).join('\n')
    expect(body).toContain('File Write')
    expect(body).toContain('written')
    expect(body).toContain('owner-only file permissions')
    expect(body).not.toContain('Local Profile Setup')
    expect(body).not.toContain('cat >')
    expect(body).not.toContain(secret.trim())
  })

  it('refuses to overwrite existing setup files before creating resources', async () => {
    const client = makeClient()
    const app = fakeApp()
    const dir = await tempDir()
    const profilePath = join(dir, 'setup-profile.toml')
    await writeFile(profilePath, 'existing')
    const view = firstSetupView({
      client: client as never,
      zoneId: 'zone-1',
    })
    await view.init?.(app)
    Object.assign((view as unknown as { values: Record<string, string> }).values, {
      profile_path: profilePath,
      secret_file_path: join(dir, 'setup-secret'),
      write_files: 'true',
    })

    await openAndSubmit(view, app, { agent_app_name: 'agent-app-name' })
    await openAndSubmit(view, app, { provider_mode: 'none' })
    await openAndSubmit(view, app, { resource_name: 'resource-name', resource_scopes: 'scope-name' })
    await openAndSubmit(view, app, { policy_mode: 'create' })
    await view.onKey('enter', ctx(app))

    expect(app.setStatus).toHaveBeenCalledWith(expect.stringContaining('refusing to overwrite existing setup file'), 'error')
    expect(client.applications.create).not.toHaveBeenCalled()
    expect(client.resources.create).not.toHaveBeenCalled()
  })
})
