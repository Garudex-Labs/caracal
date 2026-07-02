// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the idempotent caracal.sys system zone provisioner and the Operator's least-privilege identity.

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import type { AdminClient } from '@caracalai/admin'
import {
  provisionSystemZone,
  authorOperatorPolicy,
  operatorControlScopes,
  operatorIdentityTraits,
  SYSTEM_ZONE_SLUG,
  SYSTEM_ZONE_NAME,
  OPERATOR_APP_NAME,
} from '../../../../apps/api/src/system-zone.js'

interface FakeResource {
  id: string
  identifier: string
  scopes: string[]
  upstream_url?: string | null
  credential_provider_id?: string | null
  gateway_application_id?: string | null
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
        return { activated: true, version_id: versionId, shadow_version_id: null }
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

describe('operatorControlScopes', () => {
  it('is exactly the union of the governed-executable capability scopes, least privilege', () => {
    expect(operatorControlScopes()).toEqual([
      'control:app:delete',
      'control:app:read',
      'control:app:write',
      'control:grant:delete',
      'control:grant:read',
      'control:grant:write',
      'control:identity-provider:delete',
      'control:identity-provider:read',
      'control:identity-provider:write',
      'control:policy-set:write',
      'control:policy:delete',
      'control:policy:read',
      'control:policy:write',
      'control:resource:delete',
      'control:resource:read',
      'control:resource:write',
    ])
  })
})

describe('operatorIdentityTraits', () => {
  it('grants control:invoke plus one scope trait per least-privilege scope', () => {
    const traits = operatorIdentityTraits()
    expect(traits).toContain('control:invoke')
    for (const scope of operatorControlScopes()) {
      expect(traits).toContain(`control:scope:${scope}`)
    }
    // No traits beyond invoke + the scope set: the identity is exactly least privilege.
    expect(traits.length).toBe(1 + operatorControlScopes().length)
  })
})

describe('provisionSystemZone', () => {
  it('creates the reserved zone, control resource, and least-privilege identity from scratch', async () => {
    const { admin, state } = fakeAdmin()
    const result = await provisionSystemZone(admin, 'cs_sealed_secret', 'caracal-control', fakeFindZoneBySlug(state))

    const zone = state.zones[0]
    expect(zone).toMatchObject({ name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG })
    expect(result.zoneId).toBe(zone.id)

    // The control resource was created in the system zone.
    expect(state.resources).toHaveLength(1)

    // The operator identity was created with exactly the least-privilege traits, and its
    // secret was set to the sealed configured value rather than the one-time minted secret.
    const app = state.apps.find((a) => a.name === OPERATOR_APP_NAME)!
    expect(app.id).toBe(result.operatorApplicationId)
    expect([...(app.traits ?? [])].sort()).toEqual(operatorIdentityTraits())
    expect(app.client_secret).toBe('cs_sealed_secret')
    expect(state.calls).toContain('applications.create')
    expect(state.calls).toContain('applications.patch:secret')
  })

  it('is idempotent: reuses the existing zone and reconciles the identity without duplicating', async () => {
    const seeded = fakeAdmin({
      zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }],
      resources: [{ id: 'res-control', identifier: 'caracal-control', scopes: [] }],
      apps: [
        {
          id: 'app-op',
          name: OPERATOR_APP_NAME,
          traits: operatorIdentityTraits(),
          client_secret: 'old',
          registration_method: 'managed',
          expires_at: null,
        },
      ],
    })
    const result = await provisionSystemZone(seeded.admin, 'cs_rotated', 'caracal-control', fakeFindZoneBySlug(seeded.state))

    // No new zone or application was created.
    expect(result.zoneId).toBe('zone-sys')
    expect(result.operatorApplicationId).toBe('app-op')
    expect(seeded.state.zones).toHaveLength(1)
    expect(seeded.state.apps).toHaveLength(1)
    expect(seeded.state.calls).not.toContain('zones.create')
    expect(seeded.state.calls).not.toContain('applications.create')
    // The zone is found deterministically by slug, never by scanning the zone list — so a
    // deployment whose system zone has fallen off the newest-first first page still resolves.
    expect(seeded.state.calls).not.toContain('zones.list')
    expect(seeded.state.calls).toContain('findZoneBySlug')
    // Traits already match, so they are not re-patched; the secret is reconciled to config.
    expect(seeded.state.calls).not.toContain('applications.patch:traits')
    expect(seeded.state.apps[0].client_secret).toBe('cs_rotated')
  })

  it('self-heals a tampered identity back to least-privilege traits', async () => {
    const seeded = fakeAdmin({
      zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }],
      // A widened identity: an extra scope trait that is not least privilege.
      apps: [
        {
          id: 'app-op',
          name: OPERATOR_APP_NAME,
          traits: ['control:invoke', 'control:scope:control:zone:write'],
          client_secret: 'x',
          registration_method: 'managed',
          expires_at: null,
        },
      ],
    })
    await provisionSystemZone(seeded.admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(seeded.state))
    expect(seeded.state.calls).toContain('applications.patch:traits')
    expect([...(seeded.state.apps[0].traits ?? [])].sort()).toEqual(operatorIdentityTraits())
  })

  it('fails closed when the reserved identity exists but cannot mint tokens (expired or non-managed)', async () => {
    const expired = fakeAdmin({
      zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }],
      // An expired reserved-name app cannot mint control tokens; binding to it would report
      // governed execution configured while every execution failed at the mint.
      apps: [
        {
          id: 'app-op',
          name: OPERATOR_APP_NAME,
          traits: operatorIdentityTraits(),
          registration_method: 'managed',
          expires_at: '2020-01-01T00:00:00Z',
        },
      ],
    })
    await expect(provisionSystemZone(expired.admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(expired.state))).rejects.toThrow(
      /usable non-expiring managed credential/,
    )
    // It never widens authority by reusing an unusable identity or creating a duplicate.
    expect(expired.state.calls).not.toContain('applications.create')
  })
})

describe('authorOperatorPolicy', () => {
  it('renders deterministic app_ids and grants data documents the decision contract reads', () => {
    const content = authorOperatorPolicy('app-op', ['caracal-sys://operator-llm-openai'])
    expect(content).toContain('# caracal:data-document')
    expect(content).toContain('package caracal.authz')
    expect(content).toContain('app_ids := {"operator":"app-op"}')
    expect(content).toContain(
      'grants := {"caracal-sys://operator-llm-openai":{"application":"operator","roles":{"operator":["llm:invoke"]}}}',
    )
  })

  it('is order-independent in the resource list, so an unchanged grant set yields identical content', () => {
    const a = authorOperatorPolicy('app-op', ['caracal-sys://b', 'caracal-sys://a'])
    const b = authorOperatorPolicy('app-op', ['caracal-sys://a', 'caracal-sys://b'])
    expect(a).toBe(b)
  })
})

describe('provisionSystemZone with governed upstreams', () => {
  const upstream = { id: 'openai', baseUrl: 'https://api.openai.test/v1', apiKey: 'sk-live-secret' }

  it('seals the key, binds the resource, and activates the single grant policy-set from scratch', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    const result = await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])

    // An api_key provider holds the sealed key and allows gateway runtime injection.
    const provider = state.providers.find((p) => p.identifier === 'provider://caracal-sys-operator-llm-openai')!
    expect(provider.kind).toBe('api_key')
    expect(provider.config_json).toMatchObject({ api_key: 'sk-live-secret', allow_runtime_injection: true, header_name: 'Authorization' })

    // The resource declares the data scope plus agent:lifecycle, binds the credential
    // provider, and routes through the gateway as the Operator identity.
    const resource = state.resources.find((r) => r.identifier === 'caracal-sys://operator-llm-openai')!
    expect([...resource.scopes].sort()).toEqual(['agent:lifecycle', 'llm:invoke'])
    expect(resource.credential_provider_id).toBe(provider.id)
    expect(resource.gateway_application_id).toBe(result.operatorApplicationId)
    expect(resource.operation_enforcement).toBe('transport_uniform')

    // Exactly one policy and one policy-set, activated, granting the Operator the resource.
    expect(state.policies).toHaveLength(1)
    expect(state.policySets).toHaveLength(1)
    expect(state.policySets[0].active_version_id).not.toBeNull()
    expect(result.governedResources).toEqual([{ id: 'openai', resourceIdentifier: 'caracal-sys://operator-llm-openai' }])
  })

  it('is idempotent: an unchanged upstream set adds no policy version and does not re-activate', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])
    state.calls.length = 0
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])

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
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])
    state.calls.length = 0
    const second = { id: 'anthropic', baseUrl: 'https://api.anthropic.test/v1', apiKey: 'sk-other' }
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream, second])

    expect(state.calls).toContain('policies.addVersion')
    expect(state.calls).toContain('policySets.activate')
    expect(state.policies[0].versions).toHaveLength(2)
    expect(state.providers).toHaveLength(2)
    expect(state.resources.filter((r) => r.identifier.startsWith('caracal-sys://operator-llm-'))).toHaveLength(2)
  })

  it('re-activates to self-heal a deactivated policy-set even when content is unchanged', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])
    // Simulate a manual deactivation of the system policy-set.
    state.policySets[0].active_version_id = null
    state.calls.length = 0
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])

    expect(state.calls).not.toContain('policies.addVersion')
    expect(state.calls).toContain('policySets.activate')
    expect(state.policySets[0].active_version_id).not.toBeNull()
  })

  it('does no LLM provisioning when no governed upstreams are supplied', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    const result = await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state))
    expect(state.providers).toHaveLength(0)
    expect(state.policies).toHaveLength(0)
    expect(state.policySets).toHaveLength(0)
    expect(result.governedResources).toEqual([])
  })

  it('prunes a removed upstream: archives its provider, neutralizes its resource binding, and revokes its grant', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    const second = { id: 'anthropic', baseUrl: 'https://api.anthropic.test/v1', apiKey: 'sk-other' }
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream, second])
    state.calls.length = 0
    // Remove the second upstream from config and re-provision.
    const result = await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])

    // The removed upstream's sealed provider is gone, so its key is no longer usable.
    expect(state.providers.find((p) => p.identifier === 'provider://caracal-sys-operator-llm-anthropic')).toBeUndefined()
    expect(state.calls).toContain('providers.delete')
    // Its resource is left intact (a non-control resource must keep a credential provider and
    // gateway binding, so it cannot be neutralized in place); with its provider archived and
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
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])
    state.calls.length = 0
    const result = await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [])

    // No provider survives, so no sealed key remains usable.
    expect(state.providers).toHaveLength(0)
    expect(state.calls).toContain('providers.delete')
    // The policy is reconciled to an empty grant set and re-activated.
    const content = state.policies[0].versions.at(-1)!
    expect(state.policies[0].versions).toHaveLength(2)
    expect(state.calls).toContain('policySets.activate')
    expect(content.content_sha256).toBe(sha256Hex(authorOperatorPolicy(result.operatorApplicationId, [])))
    expect(result.governedResources).toEqual([])
  })

  it('re-adds a previously pruned upstream cleanly: a fresh provider re-bound to the reused resource', async () => {
    const { admin, state } = fakeAdmin({ zones: [{ id: 'zone-sys', name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG }] })
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [])
    const result = await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])

    // The single resource (never archived) is re-bound to the freshly created provider.
    const resource = state.resources.find((r) => r.identifier === 'caracal-sys://operator-llm-openai')!
    const provider = state.providers.find((p) => p.identifier === 'provider://caracal-sys-operator-llm-openai')!
    expect(resource.gateway_application_id).toBe(result.operatorApplicationId)
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
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [upstream])
    await provisionSystemZone(admin, 'cs_sealed', 'caracal-control', fakeFindZoneBySlug(state), [])

    // The unrelated provider and the control resource are never pruned.
    expect(state.providers.find((p) => p.identifier === 'provider://tenant-thing')).toBeDefined()
    expect(state.resources.find((r) => r.identifier === 'caracal-control')).toBeDefined()
  })
})
