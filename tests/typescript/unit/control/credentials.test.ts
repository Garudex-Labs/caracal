// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control credential helpers provision the OAuth resource required for invocation tokens.

import { describe, expect, it, vi } from 'vitest'

import { controlKeyCreate, ensureControlResource } from '../../../../packages/engine/src/control.ts'
import type { AdminClient, Resource } from '../../../../packages/admin/ts/src/index.ts'

function client(resources: Resource[] = []): AdminClient {
  return {
    resources: {
      list: vi.fn(async () => resources),
      create: vi.fn(async (_zoneId: string, input: Partial<Resource>) => ({
        id: 'res-1',
        zone_id: 'z1',
        name: input.name,
        identifier: input.identifier,
        upstream_url: null,
        gateway_application_id: null,
        scopes: input.scopes,
        credential_provider_id: null,
        created_at: 'now',
        updated_at: 'now',
      })),
      patch: vi.fn(async (_zoneId: string, id: string, input: Partial<Resource>) => ({
        ...resources.find((resource) => resource.id === id)!,
        ...input,
      })),
    },
    applications: {
      create: vi.fn(async (_zoneId: string, input: object) => ({
        id: 'app-1',
        zone_id: 'z1',
        created_at: 'now',
        client_secret: 'cs_generated',
        ...input,
      })),
    },
  } as unknown as AdminClient
}

describe('control credentials', () => {
  it('creates the control resource before creating a control key', async () => {
    const c = client()

    const result = await controlKeyCreate(c, 'z1', {
      name: 'robot',
      scopes: ['control:agent:read'],
      maxTtlSeconds: 300,
      expiresAt: '2999-01-01T00:00:00.000Z',
    })

    expect(c.resources.list).toHaveBeenCalledWith('z1', { controlResource: true })
    expect(c.resources.create).toHaveBeenCalledWith('z1', expect.objectContaining({
      identifier: 'caracal-control',
      scopes: expect.arrayContaining(['control:agent:read', 'control:agent:write', 'control:agent:delete']),
    }), { controlResource: true })
    expect(c.applications.create).toHaveBeenCalledWith('z1', expect.objectContaining({
      name: 'robot',
      traits: expect.arrayContaining([
        'control:invoke',
        'control:scope:control:agent:read',
        'control:max-ttl:300',
        'control:expires:2999-01-01T00:00:00.000Z',
      ]),
    }))
    expect(result.resource.identifier).toBe('caracal-control')
    expect(result.clientSecret).toBe('cs_generated')
    expect(result.allowedScopes).toEqual(['control:agent:read'])
    expect(result.maxTtlSeconds).toBe(300)
    expect(result.expiresAt).toBe('2999-01-01T00:00:00.000Z')
  })

  it('requires explicit control key permissions', async () => {
    await expect(controlKeyCreate(client(), 'z1', { name: 'robot' })).rejects.toThrow('control key permissions are required')
  })

  it('derives permissions from resource and action selectors', async () => {
    const c = client()

    const result = await controlKeyCreate(c, 'z1', {
      name: 'reader',
      resources: ['agent'],
      actions: ['read'],
    })

    expect(result.allowedScopes).toEqual(['control:agent:read'])
    expect(c.applications.create).toHaveBeenCalledWith('z1', expect.objectContaining({
      traits: expect.arrayContaining(['control:scope:control:agent:read']),
    }))
  })

  it('reconciles an existing control resource to the current remote surface', async () => {
    const existing = {
      id: 'res-1',
      zone_id: 'z1',
      name: 'Control API',
      identifier: 'caracal-control',
      upstream_url: null,
      gateway_application_id: null,
      scopes: ['control:zone:read'],
      credential_provider_id: null,
      created_at: 'now',
      updated_at: 'now',
    } as Resource
    const c = client([existing])

    await ensureControlResource(c, 'z1')

    expect(c.resources.patch).toHaveBeenCalledWith('z1', 'res-1', expect.objectContaining({
      scopes: expect.arrayContaining(['control:agent:write', 'control:agent:delete']),
    }), { controlResource: true })
    expect((c.resources.patch as ReturnType<typeof vi.fn>).mock.calls[0][2].scopes).not.toContain('control:zone:read')
  })
})
