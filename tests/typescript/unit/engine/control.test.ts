// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Engine Control API key helper tests cover resources, traits, rotation, and validation.

import { describe, expect, it, vi } from 'vitest'
import type { AdminClient, Application, Resource } from '../../../../packages/admin/ts/src/client.js'
import {
  CONTROL_EXPIRES_TRAIT_PREFIX,
  CONTROL_INVOKE_TRAIT,
  CONTROL_MAX_TTL_TRAIT_PREFIX,
  CONTROL_SCOPE_TRAIT_PREFIX,
  controlKeyCreate,
  controlKeyGet,
  controlKeyList,
  controlKeyRecord,
  controlKeyRevoke,
  controlKeyRotate,
  controlPermissions,
  controlScopes,
  ensureControlResource,
} from '../../../../packages/engine/src/control.js'

function app(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    zone_id: 'z1',
    name: 'Control Key',
    registration_method: 'managed',
    traits: [CONTROL_INVOKE_TRAIT],
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Application
}

function resource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'res-1',
    zone_id: 'z1',
    name: 'Control API',
    identifier: 'caracal-control',
    scopes: ['control:agent:read'],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Resource
}

function client(): AdminClient {
  return {
    resources: {
      list: vi.fn(async () => []),
      create: vi.fn(async (_zone: string, body: Partial<Resource>) => resource({ ...body, id: 'res-created' })),
      patch: vi.fn(async (_zone: string, _id: string, body: Partial<Resource>) => resource({ ...body })),
    },
    applications: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => app()),
      create: vi.fn(async (_zone: string, body: Partial<Application>) => app({ ...body, id: 'app-created', client_secret: 'secret-once' })),
      patch: vi.fn(async (_zone: string, id: string, body: Partial<Application>) => app({ id, ...body })),
      delete: vi.fn(async () => undefined),
    },
  } as unknown as AdminClient
}

describe('control metadata helpers', () => {
  it('derives sorted scopes, permissions, and records from application traits', () => {
    const scopes = controlScopes()
    expect(scopes).toContain('control:agent:read')
    expect(scopes).not.toContain('control:zone:read')
    expect(controlPermissions().find((permission) => permission.scope === 'control:agent:delete')).toMatchObject({
      command: 'agent',
      action: 'delete',
    })
    expect(controlKeyRecord(app({
      traits: [
        CONTROL_INVOKE_TRAIT,
        `${CONTROL_SCOPE_TRAIT_PREFIX}control:agent:read`,
        `${CONTROL_SCOPE_TRAIT_PREFIX}not-real`,
        `${CONTROL_MAX_TTL_TRAIT_PREFIX}120`,
        `${CONTROL_EXPIRES_TRAIT_PREFIX}2027-01-01T00:00:00.000Z`,
      ],
    }))).toMatchObject({
      allowed_scopes: ['control:agent:read'],
      max_ttl_seconds: 120,
      expires_at: '2027-01-01T00:00:00.000Z',
      restrictions: ['zone-bound', 'application-only', 'no-subject-token', 'no-delegation'],
    })
  })
})

describe('ensureControlResource', () => {
  it('creates the control resource when absent and patches missing scopes when present', async () => {
    const admin = client()
    await expect(ensureControlResource(admin, 'z1')).resolves.toMatchObject({ id: 'res-created' })
    expect(admin.resources.create).toHaveBeenCalledWith('z1', expect.objectContaining({
      identifier: 'caracal-control',
      scopes: expect.arrayContaining(['control:agent:read']),
    }))

    admin.resources.list = vi.fn(async () => [resource({ scopes: [] })])
    await ensureControlResource(admin, 'z1')
    expect(admin.resources.patch).toHaveBeenCalledWith('z1', 'res-1', expect.objectContaining({
      scopes: expect.arrayContaining(['control:agent:read']),
    }))

    admin.resources.list = vi.fn(async () => [resource({ scopes: ['control:zone:read'] })])
    await ensureControlResource(admin, 'z1')
    expect((admin.resources.patch as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2].scopes).not.toContain('control:zone:read')
  })

  it('returns the existing resource when scopes already match', async () => {
    const admin = client()
    const existing = resource({ scopes: controlScopes() })
    admin.resources.list = vi.fn(async () => [existing])
    await expect(ensureControlResource(admin, 'z1')).resolves.toBe(existing)
    expect(admin.resources.patch).not.toHaveBeenCalled()
  })
})

describe('control key lifecycle', () => {
  it('lists, reads, creates, rotates, and revokes control key applications', async () => {
    const admin = client()
    admin.applications.list = vi.fn(async () => [
      app({ id: 'control-app' }),
      app({ id: 'normal-app', traits: [] }),
    ])
    await expect(controlKeyList(admin, 'z1')).resolves.toHaveLength(1)

    await expect(controlKeyGet(admin, 'z1', 'control-app')).resolves.toMatchObject({ client_id: 'app-1' })

    const created = await controlKeyCreate(admin, 'z1', {
      name: 'CI Control',
      scopes: ['control:agent:read'],
      maxTtlSeconds: 120,
      expiresAt: '2027-01-01T00:00:00.000Z',
    })
    expect(created).toMatchObject({
      name: 'CI Control',
      clientId: 'app-created',
      clientSecret: 'secret-once',
      allowedScopes: ['control:agent:read'],
      maxTtlSeconds: 120,
      expiresAt: '2027-01-01T00:00:00.000Z',
    })

    const rotated = await controlKeyRotate(admin, 'z1', 'control-app')
    expect(rotated.clientId).toBe('control-app')
    expect(rotated.clientSecret).toMatch(/^cs_/)
    expect(admin.applications.patch).toHaveBeenCalledWith('z1', 'control-app', {
      client_secret: rotated.clientSecret,
    })

    await controlKeyRevoke(admin, 'z1', 'control-app')
    expect(admin.applications.delete).toHaveBeenCalledWith('z1', 'control-app')
  })

  it('rejects invalid key definitions and non-control applications', async () => {
    const admin = client()
    admin.applications.get = vi.fn(async () => app({ traits: [] }))
    await expect(controlKeyGet(admin, 'z1', 'normal-app')).rejects.toThrow('not a control API key')

    await expect(controlKeyCreate(client(), 'z1', { name: 'No Permissions' }))
      .rejects.toThrow('permissions are required')
    await expect(controlKeyCreate(client(), 'z1', { name: 'Bad Scope', scopes: ['not-real'] }))
      .rejects.toThrow('unsupported control scope')
    await expect(controlKeyCreate(client(), 'z1', { name: 'Bad TTL', scopes: ['control:agent:read'], maxTtlSeconds: 59 }))
      .rejects.toThrow('between 60 and 900')
    await expect(controlKeyCreate(client(), 'z1', { name: 'Bad Expiry', scopes: ['control:agent:read'], expiresAt: 'bad' }))
      .rejects.toThrow('ISO timestamp')
    await expect(controlKeyCreate(client(), 'z1', { name: 'Global Zone', scopes: ['control:zone:read'] }))
      .rejects.toThrow('unsupported control scope')
  })

  it('can derive permissions from actions and resources', async () => {
    const admin = client()
    const created = await controlKeyCreate(admin, 'z1', {
      name: 'Agent Readers',
      actions: ['read'],
      resources: ['agent'],
    })
    expect(created.allowedScopes).toEqual(['control:agent:read'])
  })
})
