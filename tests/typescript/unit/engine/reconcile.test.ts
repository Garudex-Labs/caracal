// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Validates the server-side declarative reconciler: idempotent upsert, drift, dry-run plan, prune, zone alignment, and per-noun scope checks.

import { describe, it, expect, vi } from 'vitest'
import { reconcile, ensure, parseDesiredState, type ReconcileDeps } from '../../../../packages/engine/src/reconcile.js'
import { DispatchError } from '../../../../packages/engine/src/dispatch.js'
import type { AdminClient } from '../../../../packages/admin/ts/src/client.js'

const ZONE = 'zone-1'

interface Store {
  apps: Record<string, unknown>[]
  providers: Record<string, unknown>[]
  resources: Record<string, unknown>[]
  policies: Record<string, unknown>[]
  policyVersions: Record<string, { version: number; content_sha256: string }[]>
}

function newStore(): Store {
  return { apps: [], providers: [], resources: [], policies: [], policyVersions: {} }
}

let seq = 0
function id(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

function fakeAdmin(store: Store): AdminClient {
  return {
    applications: {
      list: vi.fn(async () => store.apps),
      create: vi.fn(async (_zone: string, input: Record<string, unknown>) => {
        const app = { id: id('app'), ...input }
        store.apps.push(app)
        return app
      }),
      patch: vi.fn(async (_zone: string, appId: string, patch: Record<string, unknown>) => {
        const app = store.apps.find((a) => a.id === appId)!
        Object.assign(app, patch)
        return app
      }),
      delete: vi.fn(async (_zone: string, appId: string) => {
        store.apps = store.apps.filter((a) => a.id !== appId)
      }),
    },
    resources: {
      list: vi.fn(async () => store.resources),
      create: vi.fn(async (_zone: string, input: Record<string, unknown>) => {
        const resource = { id: id('res'), ...input }
        store.resources.push(resource)
        return resource
      }),
      patch: vi.fn(async (_zone: string, resId: string, patch: Record<string, unknown>) => {
        const resource = store.resources.find((r) => r.id === resId)!
        Object.assign(resource, patch)
        return resource
      }),
      delete: vi.fn(async (_zone: string, resId: string) => {
        store.resources = store.resources.filter((r) => r.id !== resId)
      }),
    },
    providers: {
      list: vi.fn(async () => store.providers),
      create: vi.fn(async (_zone: string, input: Record<string, unknown>) => {
        const provider = { id: id('idp'), ...input, config_json: input.config_json }
        store.providers.push(provider)
        return provider
      }),
      patch: vi.fn(async (_zone: string, idpId: string, patch: Record<string, unknown>) => {
        const provider = store.providers.find((p) => p.id === idpId)!
        Object.assign(provider, patch)
        return provider
      }),
      delete: vi.fn(async (_zone: string, idpId: string) => {
        store.providers = store.providers.filter((p) => p.id !== idpId)
      }),
    },
    policies: {
      list: vi.fn(async () => store.policies),
      get: vi.fn(async (_zone: string, policyId: string) => {
        const policy = store.policies.find((p) => p.id === policyId)!
        return { ...policy, versions: store.policyVersions[policyId] ?? [] }
      }),
      create: vi.fn(async (_zone: string, input: Record<string, unknown>) => {
        const policy = { id: id('pol'), ...input }
        store.policies.push(policy)
        store.policyVersions[policy.id] = [{ version: 1, content_sha256: sha(input.content as string) }]
        return policy
      }),
      addVersion: vi.fn(async (_zone: string, policyId: string, content: string) => {
        const versions = store.policyVersions[policyId] ?? []
        versions.push({ version: versions.length + 1, content_sha256: sha(content) })
        store.policyVersions[policyId] = versions
        return store.policies.find((p) => p.id === policyId)!
      }),
      delete: vi.fn(async (_zone: string, policyId: string) => {
        store.policies = store.policies.filter((p) => p.id !== policyId)
      }),
    },
    policySets: {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as AdminClient
}

import { createHash } from 'node:crypto'
function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function allowAll(): ReconcileDeps['authorize'] {
  return () => undefined
}

describe('reconcile', () => {
  it('creates objects that are missing', async () => {
    const store = newStore()
    const deps: ReconcileDeps = { admin: fakeAdmin(store), authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [{ kind: 'resource', spec: { identifier: 'resource://nucleus', name: 'Nucleus', scopes: ['read'] } }],
    })
    const report = await reconcile(ZONE, doc, deps)
    expect(report.ok).toBe(true)
    expect(report.summary.created).toBe(1)
    expect(report.drift).toBe(true)
    expect(store.resources).toHaveLength(1)
    expect(store.resources[0].identifier).toBe('resource://nucleus')
  })

  it('is idempotent: a second run reports unchanged with no writes', async () => {
    const store = newStore()
    const admin = fakeAdmin(store)
    const deps: ReconcileDeps = { admin, authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [{ kind: 'application', spec: { name: 'Anton', traits: ['agent'] } }],
    })
    await reconcile(ZONE, doc, deps)
    const second = await reconcile(ZONE, doc, deps)
    expect(second.summary.unchanged).toBe(1)
    expect(second.summary.created).toBe(0)
    expect(second.drift).toBe(false)
    expect(admin.applications.create).toHaveBeenCalledTimes(1)
  })

  it('lists each kind once regardless of object count, even with prune', async () => {
    const store = newStore()
    const admin = fakeAdmin(store)
    const deps: ReconcileDeps = { admin, authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [
        { kind: 'resource', spec: { identifier: 'resource://nucleus', scopes: [] } },
        { kind: 'resource', spec: { identifier: 'resource://piperchat', scopes: [] } },
        { kind: 'resource', spec: { identifier: 'resource://hoolibox', scopes: [] } },
        { kind: 'application', spec: { name: 'Anton', traits: [] } },
      ],
      prune: true,
    })
    await reconcile(ZONE, doc, deps, { prune: true })
    expect(admin.resources.list).toHaveBeenCalledTimes(1)
    expect(admin.applications.list).toHaveBeenCalledTimes(1)
  })

  it('patches drifted objects', async () => {
    const store = newStore()
    const admin = fakeAdmin(store)
    const deps: ReconcileDeps = { admin, authorize: allowAll() }
    await reconcile(
      ZONE,
      parseDesiredState({
        objects: [{ kind: 'application', spec: { name: 'Fiona', traits: ['agent'] } }],
      }),
      deps,
    )
    const report = await reconcile(
      ZONE,
      parseDesiredState({
        objects: [{ kind: 'application', spec: { name: 'Fiona', traits: ['agent', 'reviewer'] } }],
      }),
      deps,
    )
    expect(report.summary.updated).toBe(1)
    expect(report.outcomes[0].drift).toEqual(['traits'])
    expect(store.apps[0].traits).toEqual(['agent', 'reviewer'])
  })

  it('refuses privileged trait namespaces for every declarative caller', async () => {
    const deps: ReconcileDeps = { admin: fakeAdmin(newStore()), authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [{ kind: 'application', spec: { name: 'Fiona', traits: ['agent', 'control:invoke'] } }],
    })
    await expect(reconcile(ZONE, doc, deps)).rejects.toThrow(DispatchError)
  })

  it('refuses to update an application that is a control key', async () => {
    const store = newStore()
    store.apps.push({
      id: 'app-ck',
      zone_id: ZONE,
      name: 'Fiona',
      traits: ['control:invoke'],
      created_at: '2026-01-01T00:00:00.000Z',
    })
    const admin = fakeAdmin(store)
    const deps: ReconcileDeps = { admin, authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [{ kind: 'application', spec: { name: 'Fiona', traits: ['agent'] } }],
    })
    const report = await reconcile(ZONE, doc, deps)
    expect(report.ok).toBe(false)
    expect(report.outcomes[0].error).toMatchObject({ code: 'denied', reason: expect.stringContaining('control key') })
    expect(admin.applications.patch).not.toHaveBeenCalled()
    expect(store.apps[0].traits).toEqual(['control:invoke'])
  })

  it('dry-run computes a plan without writing', async () => {
    const store = newStore()
    const admin = fakeAdmin(store)
    const deps: ReconcileDeps = { admin, authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [{ kind: 'resource', spec: { identifier: 'resource://piperchat', scopes: [] } }],
    })
    const report = await reconcile(ZONE, doc, deps, { dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.drift).toBe(true)
    expect(report.outcomes[0]).toMatchObject({ action: 'create', applied: false })
    expect(admin.resources.create).not.toHaveBeenCalled()
    expect(store.resources).toHaveLength(0)
  })

  it('republishes a policy only when its content changes', async () => {
    const store = newStore()
    const admin = fakeAdmin(store)
    const deps: ReconcileDeps = { admin, authorize: allowAll() }
    const v1 = { objects: [{ kind: 'policy', spec: { name: 'pipernet-baseline', content: 'package a\nallow := true' } }] }
    await reconcile(ZONE, parseDesiredState(v1), deps)
    const same = await reconcile(ZONE, parseDesiredState(v1), deps)
    expect(same.summary.unchanged).toBe(1)
    expect(admin.policies.addVersion).not.toHaveBeenCalled()
    const changed = await reconcile(
      ZONE,
      parseDesiredState({
        objects: [{ kind: 'policy', spec: { name: 'pipernet-baseline', content: 'package a\nallow := false' } }],
      }),
      deps,
    )
    expect(changed.summary.updated).toBe(1)
    expect(admin.policies.addVersion).toHaveBeenCalledTimes(1)
  })

  it('prunes undeclared objects but keeps control:invoke applications', async () => {
    const store = newStore()
    store.apps.push({ id: 'app-control', name: 'bootstrap', traits: ['control:invoke'] })
    store.apps.push({ id: 'app-stale', name: 'stale', traits: [] })
    const admin = fakeAdmin(store)
    const deps: ReconcileDeps = { admin, authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [{ kind: 'application', spec: { name: 'Anton', traits: ['agent'] } }],
      prune: true,
    })
    const report = await reconcile(ZONE, doc, deps, { prune: true })
    expect(report.summary.pruned).toBe(1)
    const names = store.apps.map((a) => a.name)
    expect(names).toContain('bootstrap')
    expect(names).toContain('Anton')
    expect(names).not.toContain('stale')
  })

  it('fails loudly when a spec targets a different zone', async () => {
    const deps: ReconcileDeps = { admin: fakeAdmin(newStore()), authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [{ kind: 'resource', spec: { identifier: 'resource://nucleus', zone_id: 'other-zone' } }],
    })
    await expect(reconcile(ZONE, doc, deps)).rejects.toMatchObject({ code: 'zone_mismatch' })
  })

  it('denies before any write when the principal lacks the write scope', async () => {
    const store = newStore()
    const admin = fakeAdmin(store)
    const authorize: ReconcileDeps['authorize'] = (command, verb) => {
      if (verb === 'write') throw new DispatchError('denied', `missing scope control:${command}:write`)
    }
    const doc = parseDesiredState({
      objects: [{ kind: 'resource', spec: { identifier: 'resource://nucleus' } }],
    })
    await expect(reconcile(ZONE, doc, { admin, authorize })).rejects.toMatchObject({ code: 'denied' })
    expect(admin.resources.create).not.toHaveBeenCalled()
  })

  it('allows read-only dry-run without a write scope', async () => {
    const store = newStore()
    const admin = fakeAdmin(store)
    const authorize: ReconcileDeps['authorize'] = (command, verb) => {
      if (verb !== 'read') throw new DispatchError('denied', `missing scope control:${command}:${verb}`)
    }
    const doc = parseDesiredState({
      objects: [{ kind: 'resource', spec: { identifier: 'resource://nucleus' } }],
    })
    const report = await reconcile(ZONE, doc, { admin, authorize }, { dryRun: true })
    expect(report.drift).toBe(true)
    expect(admin.resources.create).not.toHaveBeenCalled()
  })

  it('records per-object errors and keeps going', async () => {
    const store = newStore()
    const admin = fakeAdmin(store)
    admin.resources.create = vi.fn(async () => {
      throw Object.assign(new Error('conflict'), { status: 409 })
    })
    const deps: ReconcileDeps = { admin, authorize: allowAll() }
    const doc = parseDesiredState({
      objects: [
        { kind: 'resource', spec: { identifier: 'resource://nucleus' } },
        { kind: 'application', spec: { name: 'Fiona', traits: [] } },
      ],
    })
    const report = await reconcile(ZONE, doc, deps)
    expect(report.ok).toBe(false)
    expect(report.summary.failed).toBe(1)
    expect(report.outcomes[0].error).toMatchObject({ code: 'conflict' })
    expect(store.apps).toHaveLength(1)
  })

  it('ensure converges a single object', async () => {
    const store = newStore()
    const deps: ReconcileDeps = { admin: fakeAdmin(store), authorize: allowAll() }
    const report = await ensure(ZONE, 'application', { name: 'Anton', traits: ['agent'] }, deps)
    expect(report.summary.created).toBe(1)
    expect(store.apps[0].name).toBe('Anton')
  })
})

describe('parseDesiredState', () => {
  it('rejects a non-object document', () => {
    expect(() => parseDesiredState(null)).toThrow(/document must be a JSON object/)
  })

  it('rejects an unknown kind', () => {
    expect(() => parseDesiredState({ objects: [{ kind: 'widget', spec: {} }] })).toThrow(/unknown object kind/)
  })

  it('requires a spec object', () => {
    expect(() => parseDesiredState({ objects: [{ kind: 'resource' }] })).toThrow(/spec must be an object/)
  })
})
