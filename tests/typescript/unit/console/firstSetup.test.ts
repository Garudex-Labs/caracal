// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// First setup workflow creates production onboarding resources without dummy data.

import { describe, it, expect, vi } from 'vitest'
import { firstSetupView } from '../../../../apps/console/src/views/setup.ts'
import { DetailView } from '../../../../apps/console/src/views/detail.ts'
import { FormView } from '../../../../apps/console/src/views/form.ts'
import type { App } from '../../../../apps/console/src/screen.ts'

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
      get: vi.fn(async () => ({ id: 'zone-1', slug: 'platform', name: 'Platform' })),
      create: vi.fn(async () => ({ id: 'zone-1', slug: 'platform', name: 'Platform' })),
    },
    applications: {
      create: vi.fn(async () => ({
        id: 'app-1',
        zone_id: 'zone-1',
        name: 'Payroll agent',
        registration_method: 'managed',
        credential_type: 'token',
        traits: [],
        consent: 'false',
        created_at: '2026-01-01T00:00:00.000Z',
      })),
    },
    resources: {
      create: vi.fn(async () => ({
        id: 'res-1',
        zone_id: 'zone-1',
        name: 'Payroll API',
        identifier: 'resource://payroll',
        upstream_url: 'https://payroll.internal',
        gateway_application_id: 'app-1',
        prefix: true,
        scopes: ['read'],
        credential_provider_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    },
    policies: {
      create: vi.fn(async () => ({
        id: 'pol-1',
        zone_id: 'zone-1',
        name: 'First access policy',
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
      create: vi.fn(async () => ({ id: 'ps-1', zone_id: 'zone-1', name: 'First access policy set', created_at: '2026-01-01T00:00:00.000Z' })),
      addVersion: vi.fn(async () => ({ id: 'psv-1', policy_set_id: 'ps-1', version: 1, manifest: [], created_at: '2026-01-01T00:00:00.000Z' })),
      activate: vi.fn(async () => ({ active_version_id: 'psv-1' })),
    },
  }
}

describe('first setup workflow', () => {
  it('creates the first zone, app, resource, policy, and generated profile', async () => {
    const client = makeClient()
    const selected: string[] = []
    const app = fakeApp()
    const view = firstSetupView({
      client: client as never,
      zoneId: undefined,
      onZoneSelect: (id) => { selected.push(id) },
    }) as FormView
    ;(view as unknown as { values: Record<string, string> }).values = {
      zone_name: 'Platform',
      agent_app_name: 'Payroll agent',
      resource_identifier: 'resource://payroll',
      resource_name: 'Payroll API',
      resource_scopes: 'read',
      upstream_url: 'https://payroll.internal',
      provider_id: '',
      activate_policy: 'true',
      generate_profile: 'true',
      profile_path: '/secure/caracal/payroll.toml',
      secret_file_path: '/secure/caracal/payroll-secret',
      credential_env: '',
    }
    ;(view as unknown as { focus: number }).focus = 11

    await view.onKey('enter', { app, size: { rows: 40, cols: 120 }, status: '' })

    expect(client.zones.create).toHaveBeenCalledWith({ name: 'Platform' })
    expect(selected).toEqual(['zone-1'])
    expect(client.applications.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      name: 'Payroll agent',
      registration_method: 'managed',
      credential_type: 'token',
      client_secret: expect.stringMatching(/^cs_[A-Za-z0-9_-]+$/),
    }))
    expect(client.resources.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      identifier: 'resource://payroll',
      upstream_url: 'https://payroll.internal',
      gateway_application_id: 'app-1',
      scopes: ['read'],
    }))
    expect(client.policies.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      content: expect.stringContaining('input.principal.id == "app-1"'),
    }))
    expect(client.policySets.activate).toHaveBeenCalledWith('zone-1', 'ps-1', 'psv-1')

    const pushed = (app as unknown as { _pushed: unknown[] })._pushed
    const detail = pushed[pushed.length - 1] as DetailView
    expect(detail).toBeInstanceOf(DetailView)
    await detail.init(app)
    const body = detail.render({ app, size: { rows: 80, cols: 120 }, status: '' }).join('\n')
    expect(body).toContain('/secure/caracal/payroll.toml')
    expect(body).toContain('CARACAL_RESOURCE_PAYROLL_TOKEN')
    expect(body).toContain('Audit Explanation')
    expect(body).toContain('••••')
  })

  it('lets optional policy, profile, and Gateway setup be skipped', async () => {
    const client = makeClient()
    const app = fakeApp()
    const view = firstSetupView({
      client: client as never,
      zoneId: 'zone-1',
    }) as FormView
    ;(view as unknown as { values: Record<string, string> }).values = {
      zone_name: '',
      agent_app_name: 'Internal agent',
      resource_identifier: 'resource://internal',
      resource_name: '',
      resource_scopes: 'invoke',
      upstream_url: '',
      provider_id: '',
      activate_policy: 'false',
      generate_profile: 'false',
      profile_path: '',
      secret_file_path: '',
      credential_env: '',
    }
    ;(view as unknown as { focus: number }).focus = 11

    await view.onKey('enter', { app, size: { rows: 40, cols: 120 }, status: '' })

    expect(client.zones.create).not.toHaveBeenCalled()
    expect(client.resources.create).toHaveBeenCalledWith('zone-1', expect.objectContaining({
      identifier: 'resource://internal',
      upstream_url: undefined,
      gateway_application_id: undefined,
      scopes: ['invoke'],
    }))
    expect(client.policies.create).not.toHaveBeenCalled()
    expect(client.policySets.create).not.toHaveBeenCalled()
  })
})
