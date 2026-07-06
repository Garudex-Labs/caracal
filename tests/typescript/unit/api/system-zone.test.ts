// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the idempotent caracal.sys system zone provisioner and the Operator's least-privilege role identities.

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { authorGrantsDocument, type AdminClient } from '@caracalai/admin'
import {
  provisionSystemZone,
  roleIdentityTraits,
  SYSTEM_ZONE_SLUG,
  SYSTEM_ZONE_NAME,
  OPERATOR_APP_NAME,
  RESEARCHER_APP_NAME,
  EXECUTOR_APP_NAME,
  CONTROL_TOKEN_MAX_TTL_SEC,
  type OperatorRoleScopes,
} from '../../../../apps/api/src/system-zone.js'

interface FakeResource {
  id: string
  identifier: string
  scopes: string[]
  upstream_url?: string | null
  credential_provider_id?: string | null
  operation_enforcement?: string
}
interface FakeProvider {
  id: string
  identifier: string
  kind: string
  config_json: Record<string, unknown>
}
interface FakePolicyVersion {
  id: string
  version: number
  content_sha256: string
}
interface FakePolicy {
  id: string
  name: string
  versions: FakePolicyVersion[]
}
interface FakePolicySetVersion {
  id: string
  manifest: { policy_version_id: string }[]
}
interface FakePolicySet {
  id: string
  name: string
  active_version_id: string | null
  versions: FakePolicySetVersion[]
}

interface FakeState {
  zones: { id: string; name: string; slug: string }[]
  resources: FakeResource[]
  apps: { id: string; name: string; traits?: string[]; client_secret?: string; registration_method?: string; expires_at?: string | null }[]
  providers: FakeProvider[]
  policies: FakePolicy[]
  policySets: FakePolicySet[]
  calls: string[]
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// A by-slug lookup over the fake state, mirroring the deterministic DB lookup the
// provisioner uses in place of scanning a page of the zone list.
function fakeFindZoneBySlug(state: FakeState): (slug: string) => Promise<{ id: string } | null> {
  return async (slug: string) => {
    state.calls.push('findZoneBySlug')
    const zone = state.zones.find((z) => z.slug === slug)
    return zone ? { id: zone.id } : null
  }
}

// A minimal in-memory AdminClient double covering exactly the surface the provisioner uses.
// It records the calls it receives so a test can assert idempotent, least-privilege
// behavior without a live control plane.
function fakeAdmin(seed: Partial<FakeState> = {}): { admin: AdminClient; state: FakeState } {
  const state: FakeState = { zones: [], resources: [], apps: [], providers: [], policies: [], policySets: [], calls: [], ...seed }
  let counter = 0
  const id = (prefix: string): string => `${prefix}-${++counter}`
  const admin = {
    zones: {
      list: async () => {
        state.calls.push('zones.list')
        return state.zones
      },
      create: async (input: { name: string; slug?: string }) => {
        state.calls.push('zones.create')
        const zone = { id: id('zone'), name: input.name, slug: input.slug ?? input.name }
        state.zones.push(zone)
        return zone
      },
    },
    resources: {
      list: async () => {
        state.calls.push('resources.list')
        return state.resources
      },
      create: async (_zone: string, input: FakeResource) => {
        state.calls.push('resources.create')
        const resource = { ...input, id: id('res') }
        state.resources.push(resource)
        return resource
      },
      patch: async (_zone: string, rid: string, input: Partial<FakeResource>) => {
        state.calls.push('resources.patch')
        const resource = state.resources.find((r) => r.id === rid)!
        Object.assign(resource, input)
        return resource
      },
      delete: async (_zone: string, rid: string) => {
        state.calls.push('resources.delete')
        state.resources = state.resources.filter((r) => r.id !== rid)
      },
    },
    providers: {
      list: async () => {
        state.calls.push('providers.list')
        return state.providers
      },
      create: async (_zone: string, input: { identifier: string; kind: string; config_json: Record<string, unknown> }) => {
        state.calls.push('providers.create')
        const provider = { id: id('prov'), identifier: input.identifier, kind: input.kind, config_json: input.config_json }
        state.providers.push(provider)
        return provider
      },
      patch: async (_zone: string, pid: string, input: { config_json?: Record<string, unknown> }) => {
        state.calls.push('providers.patch')
        const provider = state.providers.find((p) => p.id === pid)!
        if (input.config_json) provider.config_json = input.config_json
        return provider
      },
      delete: async (_zone: string, pid: string) => {
        state.calls.push('providers.delete')
        state.providers = state.providers.filter((p) => p.id !== pid)
      },
    },
    policies: {
      list: async () => {
        state.calls.push('policies.list')
        return state.policies
      },
      get: async (_zone: string, pid: string) => {
        state.calls.push('policies.get')
        return state.policies.find((p) => p.id === pid)!
      },
      create: async (_zone: string, input: { name: string; content: string }) => {
        state.calls.push('policies.create')
        const versionId = id('pv')
        const policy = {
          id: id('pol'),
          name: input.name,
          versions: [{ id: versionId, version: 1, content_sha256: sha256Hex(input.content) }],
        }
        state.policies.push(policy)
        return { id: policy.id, version_id: versionId }
      },
      addVersion: async (_zone: string, pid: string, content: string) => {
        state.calls.push('policies.addVersion')
        const policy = state.policies.find((p) => p.id === pid)!
        const versionId = id('pv')
        policy.versions.push({ id: versionId, version: policy.versions.length + 1, content_sha256: sha256Hex(content) })
        return { version_id: versionId }
      },
    },
    policySets: {
      list: async () => {
        state.calls.push('policySets.list')
        return state.policySets
      },
      create: async (_zone: string, name: string) => {
        state.calls.push('policySets.create')
        const set = { id: id('ps'), name, active_version_id: null, versions: [] as FakePolicySetVersion[] }
        state.policySets.push(set)
        return set
      },
      addVersion: async (_zone: string, sid: string, manifest: { policy_version_id: string }[]) => {
        state.calls.push('policySets.addVersion')
        const set = state.policySets.find((s) => s.id === sid)!
        const versionId = id('psv')
        set.versions.push({ id: versionId, manifest })
        return { version_id: versionId }
      },
      activate: async (_zone: string, sid: string, versionId: string) => {
        state.calls.push('policySets.activate')
        const set = state.policySets.find((s) => s.id === sid)!
        set.active_version_id = versionId
        return { activated: true, version_id: versionId }
      },
    },
    applications: {
      list: async () => {
        state.calls.push('applications.list')
        return state.apps
      },
      create: async (_zone: string, input: { name: string; traits?: string[] }) => {
        state.calls.push('applications.create')
        const app = {
          id: id('app'),
          name: input.name,
          traits: input.traits,
          client_secret: 'cs_minted_once',
          registration_method: 'managed',
          expires_at: null,
        }
        state.apps.push(app)
        return app
      },
      patch: async (_zone: string, aid: string, input: { traits?: string[]; client_secret?: string }) => {
        state.calls.push(`applications.patch:${input.client_secret ? 'secret' : 'traits'}`)
        const app = state.apps.find((a) => a.id === aid)!
        if (input.traits) app.traits = input.traits
        if (input.client_secret) app.client_secret = input.client_secret
        return app
      },
    },
  } as unknown as AdminClient
  return { admin, state }
}

describe('roleIdentityTraits', () => {
  it('carries control:invoke, the token-lifetime cap, the credential deadline, and one sorted scope trait per scope', () => {
    const expiresAt = new Date('2026-06-01T00:00:00.000Z')
    const traits = roleIdentityTraits(['control:app:write', 'control:app:read'], expiresAt)
    expect(traits).toEqual([
      'control:invoke',
      `control:max-ttl:${CONTROL_TOKEN_MAX_TTL_SEC}`,
      'control:expires:2026-06-01T00:00:00.000Z',
      'control:scope:control:app:read',
      'control:scope:control:app:write',
    ])
  })
})

// A representative per-role scope split: the researcher reads, the executor also writes.
const roles: OperatorRoleScopes = {
  researcher: ['control:app:read'],
  executor: ['control:app:read', 'control:app:write'],
}

describe('provisionSystemZone', () => {
  it('creates the reserved zone, control resource, and one least-privilege application per role from scratch', async () => {
    const { admin, state } = fakeAdmin()
    const result = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles)

    const zone = state.zones[0]
    expect(zone).toMatchObject({ name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG })
    expect(result.zoneId).toBe(zone.id)

    // The control resource was created in the system zone.
    expect(state.resources).toHaveLength(1)

    // Each permission boundary is its own application. The base LLM identity holds no control
    // traits at all; the researcher and executor carry exactly their role's traits.
    const llm = state.apps.find((a) => a.name === OPERATOR_APP_NAME)!
    const researcher = state.apps.find((a) => a.name === RESEARCHER_APP_NAME)!
    const executor = state.apps.find((a) => a.name === EXECUTOR_APP_NAME)!
    expect(llm.id).toBe(result.llm.applicationId)
    expect(researcher.id).toBe(result.researcher.applicationId)
    expect(executor.id).toBe(result.executor.applicationId)
    expect(llm.traits).toEqual([])
    expect(researcher.traits).toEqual(roleIdentityTraits(roles.researcher, result.expiresAt))
    expect(executor.traits).toEqual(roleIdentityTraits(roles.executor, result.expiresAt))
  })

  it('issues fresh in-process secrets: each identity is sealed with the generated credential, never the one-time minted secret', async () => {
    const { admin, state } = fakeAdmin()
    const result = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles)

    for (const [name, credential] of [
      [OPERATOR_APP_NAME, result.llm],
      [RESEARCHER_APP_NAME, result.researcher],
      [EXECUTOR_APP_NAME, result.executor],
    ] as const) {
      const app = state.apps.find((a) => a.name === name)!
      expect(credential.clientSecret).toMatch(/^cs_[A-Za-z0-9_-]{40,}$/)
      expect(app.client_secret).toBe(credential.clientSecret)
      expect(app.client_secret).not.toBe('cs_minted_once')
    }
    // The three boundaries never share a credential.
    expect(new Set([result.llm.clientSecret, result.researcher.clientSecret, result.executor.clientSecret]).size).toBe(3)
    // The credential deadline is enforced, not advisory: it rides into the STS traits.
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(state.apps.find((a) => a.name === RESEARCHER_APP_NAME)!.traits).toContain(`control:expires:${result.expiresAt.toISOString()}`)
  })

  it('rotates on every run: re-provisioning reuses the applications but seals new secrets and advances the deadline', async () => {
    const { admin, state } = fakeAdmin()
    const first = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles)
    state.calls.length = 0
    const second = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles)

    // No new zone or application: rotation converges on the same objects.
    expect(state.zones).toHaveLength(1)
    expect(state.apps).toHaveLength(3)
    expect(state.calls).not.toContain('zones.create')
    expect(state.calls).not.toContain('applications.create')
    // The zone is found deterministically by slug, never by scanning the zone list - so a
    // deployment whose system zone has fallen off the newest-first first page still resolves.
    expect(state.calls).not.toContain('zones.list')
    expect(state.calls).toContain('findZoneBySlug')
    expect(second.llm.applicationId).toBe(first.llm.applicationId)
    expect(second.researcher.applicationId).toBe(first.researcher.applicationId)
    expect(second.executor.applicationId).toBe(first.executor.applicationId)
    // Rotation is revocation: sealing the new secret is what stops the previous one working.
    expect(state.calls).toContain('applications.patch:secret')
    expect(second.llm.clientSecret).not.toBe(first.llm.clientSecret)
    expect(second.researcher.clientSecret).not.toBe(first.researcher.clientSecret)
    expect(second.executor.clientSecret).not.toBe(first.executor.clientSecret)
    expect(state.apps.find((a) => a.name === EXECUTOR_APP_NAME)!.client_secret).toBe(second.executor.clientSecret)
    // The deadline always moves forward with the rotation.
    expect(second.expiresAt.getTime()).toBeGreaterThanOrEqual(first.expiresAt.getTime())
    expect(state.apps.find((a) => a.name === EXECUTOR_APP_NAME)!.traits).toContain(`control:expires:${second.expiresAt.toISOString()}`)
  })

  it('self-heals a tampered role identity back to exactly its least-privilege traits', async () => {
    const seeded = fakeAdmin({
      zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }],
      // A widened researcher: an extra write scope trait that is not least privilege.
      apps: [
        {
          id: 'app-r',
          name: RESEARCHER_APP_NAME,
          traits: ['control:invoke', 'control:scope:control:zone:write'],
          client_secret: 'x',
          registration_method: 'managed',
          expires_at: null,
        },
      ],
    })
    const result = await provisionSystemZone(seeded.admin, 'caracal-control', fakeFindZoneBySlug(seeded.state), roles)
    expect(seeded.state.calls).toContain('applications.patch:traits')
    expect(seeded.state.apps.find((a) => a.name === RESEARCHER_APP_NAME)!.traits).toEqual(
      roleIdentityTraits(roles.researcher, result.expiresAt),
    )
  })

  it('fails closed when a reserved identity exists but cannot serve as a managed credential (expired or non-managed)', async () => {
    const expired = fakeAdmin({
      zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }],
      // An app-expiring reserved-name application cannot carry the rotating credential;
      // binding to it would report governed execution configured while every mint failed.
      apps: [
        {
          id: 'app-x',
          name: EXECUTOR_APP_NAME,
          traits: [],
          registration_method: 'managed',
          expires_at: '2020-01-01T00:00:00Z',
        },
      ],
    })
    await expect(provisionSystemZone(expired.admin, 'caracal-control', fakeFindZoneBySlug(expired.state), roles)).rejects.toThrow(
      /not a usable managed credential/,
    )
    // It never widens authority by reusing an unusable identity or creating a duplicate.
    expect(expired.state.apps.filter((a) => a.name === EXECUTOR_APP_NAME)).toHaveLength(1)

    const dcr = fakeAdmin({
      zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }],
      apps: [{ id: 'app-d', name: OPERATOR_APP_NAME, traits: [], registration_method: 'dcr', expires_at: null }],
    })
    await expect(provisionSystemZone(dcr.admin, 'caracal-control', fakeFindZoneBySlug(dcr.state), roles)).rejects.toThrow(
      /not a usable managed credential/,
    )
  })
})

describe('provisionSystemZone with governed upstreams', () => {
  const upstream = { id: 'openai', baseUrl: 'https://api.openai.test/v1', apiKey: 'sk-live-secret' }

  it('seals the key, binds the resource, and activates the single grant policy-set from scratch', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    const result = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])

    // An api_key provider holds the sealed key and allows gateway runtime injection.
    const provider = state.providers.find((p) => p.identifier === 'provider://caracal-sys-operator-llm-openai')!
    expect(provider.kind).toBe('api_key')
    expect(provider.config_json).toMatchObject({ api_key: 'sk-live-secret', allow_runtime_injection: true, header_name: 'Authorization' })

    // The resource declares only its business scope (STS derives the platform-reserved
    // agent:lifecycle bootstrap scope for gateway-routed resources) and binds the
    // credential provider; the zone's grant policy alone decides which identities may
    // mint on it.
    const resource = state.resources.find((r) => r.identifier === 'caracal-sys://operator-llm-openai')!
    expect([...resource.scopes]).toEqual(['llm:invoke'])
    expect(resource.credential_provider_id).toBe(provider.id)
    expect(resource.operation_enforcement).toBe('transport_uniform')

    // Exactly one policy and one policy-set, activated, granting the base identity the resource.
    expect(state.policies).toHaveLength(1)
    expect(state.policySets).toHaveLength(1)
    expect(state.policySets[0].active_version_id).not.toBeNull()
    expect(result.governedResources).toEqual([{ id: 'openai', resourceIdentifier: 'caracal-sys://operator-llm-openai' }])
  })

  it('is idempotent: an unchanged upstream set adds no policy version and does not re-activate', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])
    state.calls.length = 0
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])

    // Steady state: no new policy version, no re-activation, no duplicate objects.
    expect(state.calls).not.toContain('policies.create')
    expect(state.calls).not.toContain('policies.addVersion')
    expect(state.calls).not.toContain('policySets.addVersion')
    expect(state.calls).not.toContain('policySets.activate')
    expect(state.calls).not.toContain('resources.patch')
    expect(state.policies).toHaveLength(1)
    expect(state.policySets).toHaveLength(1)
    expect(state.resources.filter((r) => r.identifier.startsWith('caracal-sys://operator-llm-'))).toHaveLength(1)
    expect(state.providers).toHaveLength(1)
  })

  it('adds a new policy version and re-activates when a governed upstream is added', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])
    state.calls.length = 0
    const second = { id: 'anthropic', baseUrl: 'https://api.anthropic.test/v1', apiKey: 'sk-other' }
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream, second])

    expect(state.calls).toContain('policies.addVersion')
    expect(state.calls).toContain('policySets.activate')
    expect(state.policies[0].versions).toHaveLength(2)
    expect(state.providers).toHaveLength(2)
    expect(state.resources.filter((r) => r.identifier.startsWith('caracal-sys://operator-llm-'))).toHaveLength(2)
  })

  it('re-activates to self-heal a deactivated policy-set even when content is unchanged', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])
    // Simulate a manual deactivation of the system policy-set.
    state.policySets[0].active_version_id = null
    state.calls.length = 0
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])

    expect(state.calls).not.toContain('policies.addVersion')
    expect(state.calls).toContain('policySets.activate')
    expect(state.policySets[0].active_version_id).not.toBeNull()
  })

  it('does no LLM provisioning when no governed upstreams are supplied', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    const result = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles)
    expect(state.providers).toHaveLength(0)
    expect(state.policies).toHaveLength(0)
    expect(state.policySets).toHaveLength(0)
    expect(result.governedResources).toEqual([])
  })

  it('prunes a removed upstream: archives its provider, neutralizes its resource binding, and revokes its grant', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    const second = { id: 'anthropic', baseUrl: 'https://api.anthropic.test/v1', apiKey: 'sk-other' }
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream, second])
    state.calls.length = 0
    // Remove the second upstream from config and re-provision.
    const result = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])

    // The removed upstream's sealed provider is gone, so its key is no longer usable.
    expect(state.providers.find((p) => p.identifier === 'provider://caracal-sys-operator-llm-anthropic')).toBeUndefined()
    expect(state.calls).toContain('providers.delete')
    // Its resource is left intact (a non-control resource must keep a credential provider and
    // upstream routing, so it cannot be neutralized in place); with its provider archived and
    // its grant revoked it is inert, and a later re-add patches it straight back.
    const orphan = state.resources.find((r) => r.identifier === 'caracal-sys://operator-llm-anthropic')!
    expect(orphan).toBeDefined()
    expect(state.calls).not.toContain('resources.patch')
    // The grant set is reconciled to exactly the remaining upstream.
    expect(result.governedResources).toEqual([{ id: 'openai', resourceIdentifier: 'caracal-sys://operator-llm-openai' }])
    expect(state.policies[0].versions).toHaveLength(2)
    expect(state.calls).toContain('policySets.activate')
  })

  it('reconciles grants to empty and prunes every provider when all governed upstreams are removed', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])
    state.calls.length = 0
    const result = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [])

    // No provider survives, so no sealed key remains usable.
    expect(state.providers).toHaveLength(0)
    expect(state.calls).toContain('providers.delete')
    // The policy is reconciled to an empty grant set and re-activated.
    const content = state.policies[0].versions.at(-1)!
    expect(state.policies[0].versions).toHaveLength(2)
    expect(state.calls).toContain('policySets.activate')
    expect(content.content_sha256).toBe(sha256Hex(authorGrantsDocument([])))
    expect(result.governedResources).toEqual([])
  })

  it('re-adds a previously pruned upstream cleanly: a fresh provider re-bound to the reused resource', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [])
    const result = await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])

    // The single resource (never archived) is re-bound to the freshly created provider.
    const resource = state.resources.find((r) => r.identifier === 'caracal-sys://operator-llm-openai')!
    const provider = state.providers.find((p) => p.identifier === 'provider://caracal-sys-operator-llm-openai')!
    expect(resource.credential_provider_id).toBe(provider.id)
    expect(state.resources.filter((r) => r.identifier === 'caracal-sys://operator-llm-openai')).toHaveLength(1)
    expect(result.governedResources).toEqual([{ id: 'openai', resourceIdentifier: 'caracal-sys://operator-llm-openai' }])
  })

  it('leaves non-operator providers and resources untouched while pruning', async () => {
    const { admin, state } = fakeAdmin({
      zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }],
      resources: [{ id: 'res-control', identifier: 'caracal-control', scopes: [] }],
      providers: [{ id: 'prov-keep', identifier: 'provider://tenant-thing', kind: 'api_key', config_json: {} }],
    })
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [upstream])
    await provisionSystemZone(admin, 'caracal-control', fakeFindZoneBySlug(state), roles, [])

    // The unrelated provider and the control resource are never pruned.
    expect(state.providers.find((p) => p.identifier === 'provider://tenant-thing')).toBeDefined()
    expect(state.resources.find((r) => r.identifier === 'caracal-control')).toBeDefined()
  })
})
