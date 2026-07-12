// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reconciler tests: applications, api-key providers, resources, and policy sets converge idempotently and fail closed on unusable state.

import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  authorGrantsDocument,
  ensureActivePolicySet,
  ensureApiKeyProvider,
  ensureApplication,
  ensureClientCredentialsProvider,
  ensureGovernedUpstreams,
  ensureGrants,
  ensureResource,
  type AdminClient,
} from '../../../../packages/admin/ts/src/index.js'

const ZONE = 'zone-1'

describe('ensureApplication', () => {
  function admin(existing: Record<string, unknown>[]) {
    return {
      applications: {
        list: vi.fn().mockResolvedValue(existing),
        create: vi.fn().mockResolvedValue({ id: 'app-created' }),
        patch: vi.fn().mockResolvedValue({}),
      },
    }
  }

  it('creates a managed application and seals the given secret', async () => {
    const client = admin([])
    const id = await ensureApplication(client as unknown as AdminClient, ZONE, {
      name: 'Fiona',
      traits: ['system:operator'],
      clientSecret: 'cs_fresh',
    })

    expect(id).toBe('app-created')
    expect(client.applications.create).toHaveBeenCalledWith(ZONE, {
      name: 'Fiona',
      registration_method: 'managed',
      traits: ['system:operator'],
    })
    expect(client.applications.patch).toHaveBeenCalledWith(ZONE, 'app-created', { client_secret: 'cs_fresh' })
  })

  it('fails closed when the named application is not a usable managed credential', async () => {
    const dcr = admin([{ id: 'app-1', name: 'Fiona', registration_method: 'dcr', expires_at: null, traits: [] }])
    await expect(ensureApplication(dcr as unknown as AdminClient, ZONE, { name: 'Fiona', traits: [], clientSecret: 'cs' })).rejects.toThrow(
      /not a usable managed credential/,
    )

    const expiring = admin([{ id: 'app-1', name: 'Fiona', registration_method: 'managed', expires_at: '2026-01-01T00:00:00Z', traits: [] }])
    await expect(
      ensureApplication(expiring as unknown as AdminClient, ZONE, { name: 'Fiona', traits: [], clientSecret: 'cs' }),
    ).rejects.toThrow(/not a usable managed credential/)
  })

  it('reconciles drifted traits and always rotates the secret', async () => {
    const client = admin([{ id: 'app-1', name: 'Fiona', registration_method: 'managed', expires_at: null, traits: ['stale'] }])
    const id = await ensureApplication(client as unknown as AdminClient, ZONE, {
      name: 'Fiona',
      traits: ['system:operator'],
      clientSecret: 'cs_next',
    })

    expect(id).toBe('app-1')
    expect(client.applications.patch).toHaveBeenNthCalledWith(1, ZONE, 'app-1', { traits: ['system:operator'] })
    expect(client.applications.patch).toHaveBeenNthCalledWith(2, ZONE, 'app-1', { client_secret: 'cs_next' })
  })

  it('leaves matching traits alone and only rotates the secret', async () => {
    const client = admin([{ id: 'app-1', name: 'Fiona', registration_method: 'managed', expires_at: null, traits: ['system:operator'] }])
    await ensureApplication(client as unknown as AdminClient, ZONE, {
      name: 'Fiona',
      traits: ['system:operator'],
      clientSecret: 'cs_next',
    })

    expect(client.applications.patch).toHaveBeenCalledTimes(1)
    expect(client.applications.patch).toHaveBeenCalledWith(ZONE, 'app-1', { client_secret: 'cs_next' })
  })
})

describe('ensureApiKeyProvider', () => {
  const placement = { auth_location: 'header' as const, header_name: 'Authorization', auth_scheme: 'Bearer', allow_runtime_injection: true }

  function admin(existing: Record<string, unknown>[]) {
    return {
      providers: {
        list: vi.fn().mockResolvedValue(existing),
        create: vi.fn().mockResolvedValue({ id: 'prov-created' }),
        patch: vi.fn().mockResolvedValue({}),
      },
    }
  }

  it('returns null when no provider exists and no key was supplied', async () => {
    const client = admin([])
    const id = await ensureApiKeyProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: placement,
    })

    expect(id).toBeNull()
    expect(client.providers.create).not.toHaveBeenCalled()
    expect(client.providers.patch).not.toHaveBeenCalled()
  })

  it('patches only the public placement when no key was supplied, preserving the sealed secret', async () => {
    const client = admin([{ id: 'prov-1', identifier: 'provider://hooli' }])
    const id = await ensureApiKeyProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: placement,
    })

    expect(id).toBe('prov-1')
    expect(client.providers.patch).toHaveBeenCalledWith(ZONE, 'prov-1', { config_json: placement })
  })

  it('creates the provider with the key sealed into the config', async () => {
    const client = admin([])
    const id = await ensureApiKeyProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: placement,
      apiKey: 'sk-sealed',
    })

    expect(id).toBe('prov-created')
    expect(client.providers.create).toHaveBeenCalledWith(ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      kind: 'api_key',
      config_json: { ...placement, api_key: 'sk-sealed' },
    })
  })

  it('re-seals an existing provider when a key is supplied', async () => {
    const client = admin([{ id: 'prov-1', identifier: 'provider://hooli' }])
    await ensureApiKeyProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: placement,
      apiKey: 'sk-rotated',
    })

    expect(client.providers.patch).toHaveBeenCalledWith(ZONE, 'prov-1', {
      kind: 'api_key',
      config_json: { ...placement, api_key: 'sk-rotated' },
    })
  })
})

describe('ensureClientCredentialsProvider', () => {
  const oauth = {
    token_endpoint: 'https://login.hooli.example/oauth/token',
    client_id: 'nucleus-client',
    allowed_token_hosts: ['login.hooli.example'],
  }

  function admin(existing: Record<string, unknown>[]) {
    return {
      providers: {
        list: vi.fn().mockResolvedValue(existing),
        create: vi.fn().mockResolvedValue({ id: 'prov-created' }),
        patch: vi.fn().mockResolvedValue({}),
      },
    }
  }

  it('returns null when no provider exists and the auth method needs an unsupplied credential', async () => {
    const client = admin([])
    const id = await ensureClientCredentialsProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: oauth,
    })

    expect(id).toBeNull()
    expect(client.providers.create).not.toHaveBeenCalled()
    expect(client.providers.patch).not.toHaveBeenCalled()
  })

  it('patches only the public config when no credential was supplied, preserving the sealed secret', async () => {
    const client = admin([{ id: 'prov-1', identifier: 'provider://hooli' }])
    const id = await ensureClientCredentialsProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: oauth,
    })

    expect(id).toBe('prov-1')
    expect(client.providers.patch).toHaveBeenCalledWith(ZONE, 'prov-1', { config_json: oauth })
  })

  it('creates the provider with the client secret sealed into the config', async () => {
    const client = admin([])
    const id = await ensureClientCredentialsProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: oauth,
      clientSecret: 'cs-sealed',
    })

    expect(id).toBe('prov-created')
    expect(client.providers.create).toHaveBeenCalledWith(ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      kind: 'oauth2_client_credentials',
      config_json: { ...oauth, client_secret: 'cs-sealed' },
    })
  })

  it('re-seals the signing key of an existing jwt_bearer provider', async () => {
    const client = admin([{ id: 'prov-1', identifier: 'provider://hooli' }])
    const jwtBearer = { ...oauth, grant_type: 'jwt_bearer' as const }
    await ensureClientCredentialsProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: jwtBearer,
      privateKey: 'pem-rotated',
    })

    expect(client.providers.patch).toHaveBeenCalledWith(ZONE, 'prov-1', {
      kind: 'oauth2_client_credentials',
      config_json: { ...jwtBearer, private_key: 'pem-rotated' },
    })
  })

  it('creates a public client without any credential when the auth method is none', async () => {
    const client = admin([])
    const publicClient = { ...oauth, client_auth_method: 'none' as const }
    const id = await ensureClientCredentialsProvider(client as unknown as AdminClient, ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      publicConfig: publicClient,
    })

    expect(id).toBe('prov-created')
    expect(client.providers.create).toHaveBeenCalledWith(ZONE, {
      name: 'Hooli OIDC',
      identifier: 'provider://hooli',
      kind: 'oauth2_client_credentials',
      config_json: publicClient,
    })
  })
})

describe('ensureResource', () => {
  function admin(existing: Record<string, unknown>[]) {
    return {
      resources: {
        list: vi.fn().mockResolvedValue(existing),
        create: vi
          .fn()
          .mockImplementation((_zone: string, input: Record<string, unknown>) => Promise.resolve({ id: 'res-created', ...input })),
        patch: vi.fn().mockImplementation((_zone: string, id: string, input: Record<string, unknown>) => Promise.resolve({ id, ...input })),
      },
    }
  }

  it('creates the resource with the managed fields when absent', async () => {
    const client = admin([])
    const resource = await ensureResource(client as unknown as AdminClient, ZONE, {
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
      operation_enforcement: 'transport_uniform',
    })

    expect(resource.id).toBe('res-created')
    expect(client.resources.create).toHaveBeenCalledWith(ZONE, {
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
      operation_enforcement: 'transport_uniform',
    })
  })

  it('returns the live resource without patching when nothing drifted', async () => {
    const existing = {
      id: 'res-1',
      identifier: 'resource://pipernet',
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
    }
    const client = admin([existing])
    const resource = await ensureResource(client as unknown as AdminClient, ZONE, {
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
    })

    expect(resource).toBe(existing)
    expect(client.resources.patch).not.toHaveBeenCalled()
  })

  it('patches only the managed fields on drift and ignores unmanaged ones', async () => {
    const client = admin([
      {
        id: 'res-1',
        identifier: 'resource://pipernet',
        scopes: ['data:read'],
        upstream_url: 'https://stale.pipernet.example',
        credential_provider_id: 'prov-unmanaged',
      },
    ])
    await ensureResource(client as unknown as AdminClient, ZONE, {
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
    })

    // credential_provider_id was not part of the desired state, so the patch never touches it.
    expect(client.resources.patch).toHaveBeenCalledWith(ZONE, 'res-1', {
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
    })
  })

  // Declared scopes are the resource's business vocabulary: the lifecycle bootstrap scope
  // is derived by STS for gateway-routed resources, so the reconciler sends exactly what
  // the caller declared and converges away any stamped copy on the live row.
  it('sends declared scopes verbatim and converges a stamped lifecycle scope away', async () => {
    const client = admin([
      {
        id: 'res-1',
        identifier: 'resource://pipernet',
        scopes: ['data:read', 'agent:lifecycle'],
        upstream_url: 'https://api.pipernet.example',
      },
    ])
    await ensureResource(client as unknown as AdminClient, ZONE, {
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
    })

    expect(client.resources.patch).toHaveBeenCalledWith(ZONE, 'res-1', {
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
    })
  })
})

describe('ensureActivePolicySet', () => {
  const CONTENT = 'package caracal.authz\n'
  const CONTENT_SHA = createHash('sha256').update(CONTENT, 'utf8').digest('hex')

  function admin(state: { policies?: Record<string, unknown>[]; versions?: Record<string, unknown>[]; sets?: Record<string, unknown>[] }) {
    return {
      policies: {
        list: vi.fn().mockResolvedValue(state.policies ?? []),
        create: vi.fn().mockResolvedValue({ id: 'pol-created', version_id: 'ver-created' }),
        get: vi.fn().mockResolvedValue({ id: 'pol-1', versions: state.versions ?? [] }),
        addVersion: vi.fn().mockResolvedValue({ version_id: 'ver-added' }),
      },
      policySets: {
        list: vi.fn().mockResolvedValue(state.sets ?? []),
        create: vi.fn().mockResolvedValue({ id: 'set-created', active_version_id: null }),
        addVersion: vi.fn().mockResolvedValue({ version_id: 'setver-1' }),
        activate: vi.fn().mockResolvedValue({}),
      },
    }
  }

  it('creates nothing when no policy exists and creation is suppressed', async () => {
    const client = admin({})
    await ensureActivePolicySet(client as unknown as AdminClient, ZONE, {
      policyName: 'PiperNet baseline',
      setName: 'PiperNet set',
      content: CONTENT,
      createWhenMissing: false,
    })

    expect(client.policies.create).not.toHaveBeenCalled()
    expect(client.policySets.list).not.toHaveBeenCalled()
  })

  it('creates the policy and set and activates the first version', async () => {
    const client = admin({})
    await ensureActivePolicySet(client as unknown as AdminClient, ZONE, {
      policyName: 'PiperNet baseline',
      setName: 'PiperNet set',
      content: CONTENT,
    })

    expect(client.policies.create).toHaveBeenCalledWith(ZONE, { name: 'PiperNet baseline', content: CONTENT })
    expect(client.policySets.create).toHaveBeenCalledWith(ZONE, 'PiperNet set')
    expect(client.policySets.addVersion).toHaveBeenCalledWith(ZONE, 'set-created', [{ policy_version_id: 'ver-created' }])
    expect(client.policySets.activate).toHaveBeenCalledWith(ZONE, 'set-created', 'setver-1')
  })

  it('adds and activates a new version when the content digest changed', async () => {
    const client = admin({
      policies: [{ id: 'pol-1', name: 'PiperNet baseline' }],
      versions: [{ id: 'ver-1', version: 1, content_sha256: 'stale-sha' }],
      sets: [{ id: 'set-1', name: 'PiperNet set', active_version_id: 'setver-0' }],
    })
    await ensureActivePolicySet(client as unknown as AdminClient, ZONE, {
      policyName: 'PiperNet baseline',
      setName: 'PiperNet set',
      content: CONTENT,
    })

    expect(client.policies.addVersion).toHaveBeenCalledWith(ZONE, 'pol-1', CONTENT)
    expect(client.policySets.addVersion).toHaveBeenCalledWith(ZONE, 'set-1', [{ policy_version_id: 'ver-added' }])
    expect(client.policySets.activate).toHaveBeenCalledWith(ZONE, 'set-1', 'setver-1')
  })

  it('changes nothing when the latest version already carries the content and the set is active', async () => {
    const client = admin({
      policies: [{ id: 'pol-1', name: 'PiperNet baseline' }],
      versions: [
        { id: 'ver-1', version: 1, content_sha256: 'stale-sha' },
        { id: 'ver-2', version: 2, content_sha256: CONTENT_SHA },
      ],
      sets: [{ id: 'set-1', name: 'PiperNet set', active_version_id: 'setver-0' }],
    })
    await ensureActivePolicySet(client as unknown as AdminClient, ZONE, {
      policyName: 'PiperNet baseline',
      setName: 'PiperNet set',
      content: CONTENT,
    })

    expect(client.policies.addVersion).not.toHaveBeenCalled()
    expect(client.policySets.addVersion).not.toHaveBeenCalled()
    expect(client.policySets.activate).not.toHaveBeenCalled()
  })

  it('self-heals a deactivated set by re-activating the current content', async () => {
    const client = admin({
      policies: [{ id: 'pol-1', name: 'PiperNet baseline' }],
      versions: [{ id: 'ver-2', version: 2, content_sha256: CONTENT_SHA }],
      sets: [{ id: 'set-1', name: 'PiperNet set', active_version_id: null }],
    })
    await ensureActivePolicySet(client as unknown as AdminClient, ZONE, {
      policyName: 'PiperNet baseline',
      setName: 'PiperNet set',
      content: CONTENT,
    })

    expect(client.policies.addVersion).not.toHaveBeenCalled()
    expect(client.policySets.addVersion).toHaveBeenCalledWith(ZONE, 'set-1', [{ policy_version_id: 'ver-2' }])
    expect(client.policySets.activate).toHaveBeenCalledWith(ZONE, 'set-1', 'setver-1')
  })
})

describe('authorGrantsDocument', () => {
  it('renders the app_ids and grants data documents the decision contract reads', () => {
    const content = authorGrantsDocument([
      { applicationId: 'app-anton', resourceIdentifier: 'resource://pipernet', scopes: ['data:read'], role: 'operator' },
    ])
    expect(content).toContain('# caracal:data-document')
    expect(content).toContain('package caracal.authz')
    expect(content).toContain('app_ids := {"app-anton":"app-anton"}')
    expect(content).toContain('grants := {"resource://pipernet":{"application":"app-anton","roles":{"operator":["data:read"]}}}')
  })

  it('defaults the role to the application id, matching the governed transport label default', () => {
    const content = authorGrantsDocument([{ applicationId: 'app-anton', resourceIdentifier: 'resource://pipernet', scopes: ['data:read'] }])
    expect(content).toContain('app_ids := {"app-anton":"app-anton"}')
    expect(content).toContain('"roles":{"app-anton":["data:read"]}')
  })

  it('binds one app_ids key for an application holding several roles across resources', () => {
    const content = authorGrantsDocument([
      { applicationId: 'app-1', resourceIdentifier: 'resource://a', scopes: ['a:read'], role: 'coordination' },
      { applicationId: 'app-1', resourceIdentifier: 'resource://b', scopes: ['b:export'], role: 'support-liaison' },
    ])
    expect(content).toContain('app_ids := {"app-1":"app-1"}')
    expect(content).toContain('"resource://a":{"application":"app-1","roles":{"coordination":["a:read"]}}')
    expect(content).toContain('"resource://b":{"application":"app-1","roles":{"support-liaison":["b:export"]}}')
  })

  it('is deterministic: grant order, scope order, and duplicate scopes never change the content', () => {
    const a = authorGrantsDocument([
      { applicationId: 'app-1', resourceIdentifier: 'resource://b', scopes: ['y', 'x'], role: 'operator' },
      { applicationId: 'app-1', resourceIdentifier: 'resource://a', scopes: ['x'], role: 'operator' },
    ])
    const b = authorGrantsDocument([
      { applicationId: 'app-1', resourceIdentifier: 'resource://a', scopes: ['x'], role: 'operator' },
      { applicationId: 'app-1', resourceIdentifier: 'resource://b', scopes: ['x', 'y', 'x'], role: 'operator' },
    ])
    expect(a).toBe(b)
  })

  it('merges scopes for repeated grants on the same resource and role', () => {
    const content = authorGrantsDocument([
      { applicationId: 'app-1', resourceIdentifier: 'resource://pipernet', scopes: ['data:read'], role: 'operator' },
      { applicationId: 'app-1', resourceIdentifier: 'resource://pipernet', scopes: ['data:write'], role: 'operator' },
    ])
    expect(content).toContain('"roles":{"operator":["data:read","data:write"]}')
  })

  it('rejects one resource claimed by two applications', () => {
    expect(() =>
      authorGrantsDocument([
        { applicationId: 'app-1', resourceIdentifier: 'resource://a', scopes: ['x'], role: 'operator' },
        { applicationId: 'app-2', resourceIdentifier: 'resource://a', scopes: ['x'], role: 'reader' },
      ]),
    ).toThrow(/claimed by two applications/)
  })
})

describe('ensureGrants', () => {
  function admin() {
    return {
      policies: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'pol-created', version_id: 'ver-created' }),
        get: vi.fn().mockResolvedValue({ id: 'pol-1', versions: [] }),
        addVersion: vi.fn().mockResolvedValue({ version_id: 'ver-added' }),
      },
      policySets: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'set-created', active_version_id: null }),
        addVersion: vi.fn().mockResolvedValue({ version_id: 'setver-1' }),
        activate: vi.fn().mockResolvedValue({}),
      },
    }
  }

  it('converges the default-named policy and set to the authored grant document', async () => {
    const client = admin()
    await ensureGrants(client as unknown as AdminClient, ZONE, {
      grants: [{ applicationId: 'app-anton', resourceIdentifier: 'resource://pipernet', scopes: ['data:read'] }],
    })

    expect(client.policies.create).toHaveBeenCalledWith(ZONE, {
      name: 'application-grants',
      content: authorGrantsDocument([{ applicationId: 'app-anton', resourceIdentifier: 'resource://pipernet', scopes: ['data:read'] }]),
    })
    expect(client.policySets.create).toHaveBeenCalledWith(ZONE, 'application-grant-policy')
    expect(client.policySets.activate).toHaveBeenCalled()
  })

  it('creates nothing for an empty grant set with no existing policy', async () => {
    const client = admin()
    await ensureGrants(client as unknown as AdminClient, ZONE, { grants: [] })

    expect(client.policies.create).not.toHaveBeenCalled()
    expect(client.policySets.create).not.toHaveBeenCalled()
  })

  it('uses the caller-supplied policy and set names', async () => {
    const client = admin()
    await ensureGrants(client as unknown as AdminClient, ZONE, {
      policyName: 'caracal.sys/operator-bindings',
      setName: 'caracal.sys/operator-policy',
      grants: [{ applicationId: 'app-op', resourceIdentifier: 'resource://pipernet', scopes: ['llm:invoke'], role: 'operator' }],
    })

    expect(client.policies.create).toHaveBeenCalledWith(ZONE, expect.objectContaining({ name: 'caracal.sys/operator-bindings' }))
    expect(client.policySets.create).toHaveBeenCalledWith(ZONE, 'caracal.sys/operator-policy')
  })
})

describe('ensureGovernedUpstreams', () => {
  function admin() {
    return {
      providers: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'prov-created' }),
        patch: vi.fn().mockResolvedValue({}),
      },
      resources: {
        list: vi.fn().mockResolvedValue([]),
        create: vi
          .fn()
          .mockImplementation((_zone: string, body: Record<string, unknown>) => Promise.resolve({ id: 'res-created', ...body })),
        patch: vi.fn().mockResolvedValue({}),
      },
      policies: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'pol-created', version_id: 'ver-created' }),
        get: vi.fn(),
        addVersion: vi.fn(),
      },
      policySets: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'set-created', active_version_id: null }),
        addVersion: vi.fn().mockResolvedValue({ version_id: 'setver-1' }),
        activate: vi.fn().mockResolvedValue({}),
      },
    }
  }

  const upstream = {
    provider: {
      name: 'Hooli PiperNet OIDC',
      identifier: 'provider://pipernet',
      publicConfig: { auth_location: 'header' as const, header_name: 'Authorization', auth_scheme: 'Bearer' },
      apiKey: 'sk-pipernet',
    },
    resource: {
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
    },
    grants: [{ applicationId: 'app-anton', scopes: ['data:read'] }],
  }

  it('converges provider, resource, and grants in dependency order', async () => {
    const client = admin()
    const results = await ensureGovernedUpstreams(client as unknown as AdminClient, ZONE, { upstreams: [upstream] })

    expect(client.providers.create).toHaveBeenCalledWith(ZONE, {
      name: 'Hooli PiperNet OIDC',
      identifier: 'provider://pipernet',
      kind: 'api_key',
      config_json: { auth_location: 'header', header_name: 'Authorization', auth_scheme: 'Bearer', api_key: 'sk-pipernet' },
    })
    expect(client.resources.create).toHaveBeenCalledWith(ZONE, {
      name: 'PiperNet',
      identifier: 'resource://pipernet',
      scopes: ['data:read'],
      upstream_url: 'https://api.pipernet.example',
      credential_provider_id: 'prov-created',
    })
    expect(client.policies.create).toHaveBeenCalledWith(ZONE, {
      name: 'application-grants',
      content: authorGrantsDocument([{ applicationId: 'app-anton', resourceIdentifier: 'resource://pipernet', scopes: ['data:read'] }]),
    })
    expect(results).toHaveLength(1)
    expect(results[0].providerId).toBe('prov-created')
    expect(results[0].resource.identifier).toBe('resource://pipernet')
  })

  it('fails closed before binding a resource when the provider has no sealed key', async () => {
    const client = admin()
    const keyless = { ...upstream, provider: { ...upstream.provider, apiKey: undefined } }
    await expect(ensureGovernedUpstreams(client as unknown as AdminClient, ZONE, { upstreams: [keyless] })).rejects.toThrow(
      /no sealed api key/,
    )

    expect(client.resources.create).not.toHaveBeenCalled()
    expect(client.policies.create).not.toHaveBeenCalled()
  })

  it('converges an empty set without materializing artifacts', async () => {
    const client = admin()
    const results = await ensureGovernedUpstreams(client as unknown as AdminClient, ZONE, { upstreams: [] })

    expect(results).toEqual([])
    expect(client.providers.create).not.toHaveBeenCalled()
    expect(client.resources.create).not.toHaveBeenCalled()
    expect(client.policies.create).not.toHaveBeenCalled()
  })

  it('threads caller policy and set names into the grant document', async () => {
    const client = admin()
    await ensureGovernedUpstreams(client as unknown as AdminClient, ZONE, {
      upstreams: [upstream],
      policyName: 'pied-piper-grants',
      setName: 'pied-piper-grant-policy',
    })

    expect(client.policies.create).toHaveBeenCalledWith(ZONE, expect.objectContaining({ name: 'pied-piper-grants' }))
    expect(client.policySets.create).toHaveBeenCalledWith(ZONE, 'pied-piper-grant-policy')
  })
})
