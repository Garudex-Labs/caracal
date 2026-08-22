// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the runtime governed model-provider manager and its pure registry helpers.

import { describe, it, expect } from 'vitest'
import type { AdminClient } from '@caracalai/admin'
import type { Queryable } from '../../../../apps/api/src/db.js'
import {
  createOperatorAiManager,
  buildStoreProviderConfigs,
  mergeDesiredUpstreams,
  planStoreUpstreams,
  providerConfigId,
  OperatorAiUnavailableError,
  OperatorAiNotFoundError,
  OperatorAiKeyRequiredError,
  OperatorAiConflictError,
} from '../../../../apps/api/src/operator-ai-manager.js'
import type { OperatorAiProviderRecord } from '../../../../apps/api/src/operator-ai-store.js'
import type { ProviderConfig } from '../../../../apps/api/src/operator-gateway.js'
import type { OperatorControlIdentity } from '../../../../apps/api/src/config.js'

interface StoreRow {
  slug: string
  label: string
  base_url: string
  models: string[]
  context_window: number
  enabled: boolean
  sort_order: number
  auth_config: unknown
  reconciliation_state: string
  reconciliation_error_code: string | null
  credential_required: boolean
  reconciled_at: string | Date | null
}

// An in-memory Queryable matching the store's four statements by their stable SQL shape, so the
// manager exercises the real store parameter mapping without a live database.
function fakeDb(): { db: Queryable; rows: Map<string, StoreRow> } {
  const rows = new Map<string, StoreRow>()
  let order = 0
  const db: Queryable = {
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> => {
      // Writes also contain `WHERE slug = $1`; keep all write shapes ahead of the read branch.
      if (sql.includes('INSERT INTO operator_ai_providers')) {
        const [slug, label, baseUrl, modelsJson, ctx, enabled, authJson, reconciliationState, reconciliationErrorCode, credentialRequired] =
          params as [string, string, string, string, number, boolean, string, StoreRow['reconciliation_state'], string | null, boolean]
        const existing = rows.get(slug)
        if (existing && sql.includes('ON CONFLICT (slug) DO NOTHING')) return { rows: [] }
        // Mirror the tombstone guard: no metadata write revives a row a remove already claimed.
        if (existing?.reconciliation_state === 'deleting') return { rows: [] }
        const row: StoreRow = {
          slug,
          label,
          base_url: baseUrl,
          models: JSON.parse(modelsJson),
          context_window: ctx,
          enabled,
          sort_order: existing?.sort_order ?? ++order,
          auth_config: JSON.parse(authJson),
          reconciliation_state: reconciliationState,
          reconciliation_error_code: reconciliationErrorCode,
          credential_required: credentialRequired,
          reconciled_at: null,
        }
        rows.set(slug, row)
        return { rows: [row] as T[] }
      }
      if (sql.includes('DELETE FROM operator_ai_providers')) {
        const [slug] = params as [string]
        const had = rows.delete(slug)
        return { rows: (had ? [{ slug }] : []) as T[] }
      }
      if (sql.includes('UPDATE operator_ai_providers')) {
        const [slug, reconciliationState, reconciliationErrorCode, credentialRequired] = params as [string, string, string | null, boolean]
        const row = rows.get(slug)
        if (!row) return { rows: [] }
        if (row.reconciliation_state === 'deleting' && reconciliationState !== 'deleting') return { rows: [] }
        row.reconciliation_state = reconciliationState
        row.reconciliation_error_code = reconciliationErrorCode
        row.credential_required = credentialRequired
        if (reconciliationState === 'ready') row.reconciled_at = '2026-08-20T00:00:00.000Z'
        return { rows: [row] as T[] }
      }
      if (sql.includes('WHERE slug = $1')) {
        const [slug] = params as [string]
        const row = rows.get(slug)
        return { rows: (row ? [row] : []) as T[] }
      }
      return { rows: [...rows.values()].sort((a, b) => a.sort_order - b.sort_order) as T[] }
    },
  }
  return { db, rows }
}

interface AdminState {
  providers: { id: string; identifier: string; config_json: Record<string, unknown> }[]
  resources: {
    id: string
    identifier: string
    upstream_url?: string | null
    scopes?: string[]
    credential_provider_id?: string | null
    operation_enforcement?: string
  }[]
  policies: { id: string; name: string; versions: { id: string; version: number; content_sha256: string }[] }[]
  policySets: { id: string; name: string; active_version_id: string | null }[]
  calls: string[]
}

function fakeAdmin(): { admin: AdminClient; state: AdminState; failNext: (call: string) => void } {
  const state: AdminState = { providers: [], resources: [], policies: [], policySets: [], calls: [] }
  let nextFailure: string | null = null
  const recordCall = (call: string): void => {
    state.calls.push(call)
    if (nextFailure === call) {
      nextFailure = null
      throw new Error(`injected failure at ${call}`)
    }
  }
  let counter = 0
  const id = (p: string): string => `${p}-${++counter}`
  const admin = {
    providers: {
      list: async () => state.providers,
      create: async (_z: string, input: { identifier: string; config_json: Record<string, unknown> }) => {
        recordCall(`provider.create:${input.identifier}`)
        const provider = { id: id('prov'), identifier: input.identifier, config_json: input.config_json }
        state.providers.push(provider)
        return provider
      },
      patch: async (_z: string, pid: string, input: { config_json?: Record<string, unknown> }) => {
        recordCall(`provider.patch:${pid}`)
        const provider = state.providers.find((p) => p.id === pid)!
        // Mirror real PATCH: public config is replaced, the sealed key persists unless re-supplied.
        if (input.config_json) {
          const priorKey = provider.config_json.api_key
          provider.config_json = { ...input.config_json, ...(input.config_json.api_key ? {} : priorKey ? { api_key: priorKey } : {}) }
        }
        return provider
      },
      delete: async (_z: string, pid: string) => {
        recordCall(`provider.delete:${pid}`)
        state.providers = state.providers.filter((p) => p.id !== pid)
      },
    },
    resources: {
      list: async () => state.resources,
      create: async (_z: string, input: AdminState['resources'][number]) => {
        recordCall(`resource.create:${input.identifier}`)
        const resource = { ...input, id: id('res') }
        state.resources.push(resource)
        return resource
      },
      patch: async (_z: string, rid: string, input: Partial<AdminState['resources'][number]>) => {
        recordCall(`resource.patch:${rid}`)
        const resource = state.resources.find((r) => r.id === rid)!
        Object.assign(resource, input)
        return resource
      },
    },
    policies: {
      list: async () => state.policies,
      get: async (_z: string, pid: string) => state.policies.find((p) => p.id === pid)!,
      create: async (_z: string, input: { name: string; content: string }) => {
        const versionId = id('pv')
        const policy = { id: id('pol'), name: input.name, versions: [{ id: versionId, version: 1, content_sha256: input.content }] }
        state.policies.push(policy)
        return { id: policy.id, version_id: versionId }
      },
      addVersion: async (_z: string, pid: string, content: string) => {
        const policy = state.policies.find((p) => p.id === pid)!
        const versionId = id('pv')
        policy.versions.push({ id: versionId, version: policy.versions.length + 1, content_sha256: content })
        return { version_id: versionId }
      },
    },
    policySets: {
      list: async () => state.policySets,
      create: async (_z: string, name: string) => {
        const set = { id: id('ps'), name, active_version_id: null }
        state.policySets.push(set)
        return set
      },
      addVersion: async (_z: string, _sid: string) => ({ version_id: id('psv') }),
      activate: async (_z: string, sid: string, versionId: string) => {
        const set = state.policySets.find((s) => s.id === sid)!
        set.active_version_id = versionId
        return { activated: true, version_id: versionId }
      },
    },
  }
  return {
    admin: admin as unknown as AdminClient,
    state,
    failNext: (call: string) => {
      nextFailure = call
    },
  }
}

// A governedFetch double that records the resource it is bound to, so a test can confirm
// the gateway entries route through the right minted-mandate fetch.
function fakeGovernedFetch(resourceIdentifier: string): typeof fetch {
  const fn = (async () => new Response('{}')) as unknown as typeof fetch
  ;(fn as unknown as { resourceIdentifier: string }).resourceIdentifier = resourceIdentifier
  return fn
}

const AUTH = { location: 'header' as const, headerName: 'Authorization', authScheme: 'Bearer' }
const READY_STATE = {
  reconciliationState: 'ready' as const,
  reconciliationErrorCode: null,
  credentialRequired: false,
  reconciledAt: '2026-08-20T00:00:00.000Z',
}
const IDENTITY: OperatorControlIdentity = {
  zoneId: 'sys-zone',
  llm: { applicationId: 'op-app', clientSecret: 'secret' },
  researcher: { applicationId: 'op-researcher', clientSecret: 'secret' },
  executor: { applicationId: 'op-executor', clientSecret: 'secret' },
  expiresAt: new Date(Date.now() + 3600_000),
}

function buildManager(
  identity: typeof IDENTITY | null,
  persistent?: { store: ReturnType<typeof fakeDb>; upstream: ReturnType<typeof fakeAdmin> },
  envUpstreams: { id: string; baseUrl: string; apiKey?: string }[] = [],
) {
  const store = persistent?.store ?? fakeDb()
  const upstream = persistent?.upstream ?? fakeAdmin()
  const { db } = store
  const { admin, state } = upstream
  let published: ProviderConfig[] = []
  const manager = createOperatorAiManager({
    db,
    admin,
    resolveIdentity: () => identity,
    envUpstreams,
    gatewayUrl: 'http://gateway',
    governedFetch: fakeGovernedFetch,
    onRegistryChange: (configs) => {
      published = configs
    },
    onProviderUnavailable: (slug) => {
      published = published.filter((config) => config.id !== slug && !config.id.startsWith(`${slug}__`))
    },
  })
  return {
    manager,
    state,
    rows: store.rows,
    failNext: upstream.failNext,
    getPublished: () => published,
    restart: () => buildManager(identity, { store, upstream }, envUpstreams),
  }
}

describe('operator ai manager helpers', () => {
  it('names a single-model provider by its slug and a multi-model provider per model', () => {
    expect(providerConfigId('openai', 'gpt-5.5', false)).toBe('openai')
    expect(providerConfigId('openai', 'gpt-5.5', true)).toBe('openai__gpt_5_5')
  })

  it('builds one gateway entry per model, each routed through the provider resource', () => {
    const configs = buildStoreProviderConfigs(
      [
        {
          slug: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://api',
          models: ['a', 'b'],
          contextWindow: 128000,
          enabled: true,
          sortOrder: 1,
          auth: AUTH,
          ...READY_STATE,
        },
      ],
      new Map([['openai', 'caracal-sys://operator-llm-openai']]),
      'http://gateway',
      fakeGovernedFetch,
    )
    expect(configs).toHaveLength(2)
    expect(configs.map((c) => c.id)).toEqual(['openai__a', 'openai__b'])
    expect(configs.every((c) => c.baseUrl === 'http://gateway')).toBe(true)
  })

  it('skips a disabled provider and one whose resource did not resolve', () => {
    const disabled = buildStoreProviderConfigs(
      [{ slug: 'x', label: 'X', baseUrl: 'u', models: ['m'], contextWindow: 0, enabled: false, sortOrder: 1, auth: AUTH, ...READY_STATE }],
      new Map([['x', 'res']]),
      'http://gateway',
      fakeGovernedFetch,
    )
    expect(disabled).toHaveLength(0)
    const unresolved = buildStoreProviderConfigs(
      [{ slug: 'x', label: 'X', baseUrl: 'u', models: ['m'], contextWindow: 0, enabled: true, sortOrder: 1, auth: AUTH, ...READY_STATE }],
      new Map(),
      'http://gateway',
      fakeGovernedFetch,
    )
    expect(unresolved).toHaveLength(0)
  })

  it('never publishes a provider whose durable reconciliation is incomplete', () => {
    const configs = buildStoreProviderConfigs(
      [
        {
          slug: 'pending',
          label: 'Pending',
          baseUrl: 'u',
          models: ['m'],
          contextWindow: 0,
          enabled: true,
          sortOrder: 1,
          auth: AUTH,
          reconciliationState: 'error',
          reconciliationErrorCode: 'reconciliation_failed',
          credentialRequired: true,
          reconciledAt: null,
        },
      ],
      new Map([['pending', 'res']]),
      'http://gateway',
      fakeGovernedFetch,
    )
    expect(configs).toEqual([])
  })

  it('does not publish a migrated ready row until its live resource has been verified', () => {
    const configs = buildStoreProviderConfigs(
      [
        {
          slug: 'legacy',
          label: 'Legacy',
          baseUrl: 'https://legacy.example/v1',
          models: ['legacy-model'],
          contextWindow: 0,
          enabled: true,
          sortOrder: 1,
          auth: AUTH,
          reconciliationState: 'ready',
          reconciliationErrorCode: null,
          credentialRequired: false,
          reconciledAt: null,
        },
      ],
      new Map([['legacy', 'caracal-sys://operator-llm-legacy']]),
      'http://gateway',
      fakeGovernedFetch,
    )
    expect(configs).toEqual([])
  })

  it('lets a store upstream shadow an env upstream and only seals the override slug', () => {
    const merged = mergeDesiredUpstreams(
      [{ id: 'openai', baseUrl: 'https://env', apiKey: 'env-key' }],
      [
        {
          slug: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://store',
          models: ['m'],
          contextWindow: 0,
          enabled: true,
          sortOrder: 1,
          auth: AUTH,
          ...READY_STATE,
        },
      ],
      { slug: 'openai', apiKey: 'new-key' },
    )
    expect(merged).toHaveLength(1)
    // The resource points at the endpoint the operator entered; the gateway injects the sealed key.
    expect(merged[0]).toEqual({ id: 'openai', baseUrl: 'https://store', apiKey: 'new-key', auth: AUTH })
  })

  it('reconciles a store upstream without a key when it is not the override', () => {
    const merged = mergeDesiredUpstreams(
      [],
      [
        {
          slug: 'claude',
          label: 'Claude',
          baseUrl: 'https://store',
          models: ['m'],
          contextWindow: 0,
          enabled: true,
          sortOrder: 1,
          auth: AUTH,
          ...READY_STATE,
        },
      ],
    )
    expect(merged[0].apiKey).toBeUndefined()
  })
})

describe('store upstream plan', () => {
  function record(slug: string, overrides: Partial<OperatorAiProviderRecord>): OperatorAiProviderRecord {
    return {
      slug,
      label: slug,
      baseUrl: `https://${slug}.example/v1`,
      models: ['m'],
      contextWindow: 0,
      enabled: true,
      sortOrder: 1,
      auth: AUTH,
      ...READY_STATE,
      ...overrides,
    }
  }

  it('routes only rows proven to match their sealed resource and preserves the rest', () => {
    const plan = planStoreUpstreams(
      [],
      [
        record('proven', {}),
        record('migrated', { reconciledAt: null }),
        record('waiting', { reconciliationState: 'error', reconciledAt: null, credentialRequired: true }),
        record('replayable', { reconciliationState: 'error', reconciledAt: null, credentialRequired: false }),
        record('tombstone', { reconciliationState: 'deleting', reconciledAt: null }),
      ],
    )

    expect(plan.upstreams.map((upstream) => upstream.id)).toEqual(['proven'])
    // A tombstone is deliberately absent from both sets so its sealed provider is pruned.
    expect(plan.preservedSlugs).toEqual(['migrated', 'waiting', 'replayable'])
  })

  it('replays the rows a restart can finish without a key', () => {
    const plan = planStoreUpstreams(
      [],
      [
        record('replayable', { reconciliationState: 'pending', reconciledAt: null, credentialRequired: false }),
        record('waiting', { reconciliationState: 'pending', reconciledAt: null, credentialRequired: true }),
      ],
      { recover: true },
    )

    expect(plan.upstreams.map((upstream) => upstream.id)).toEqual(['replayable'])
    expect(plan.preservedSlugs).toEqual(['waiting'])
  })

  it('admits the slug whose lifecycle write is driving the pass', () => {
    const plan = planStoreUpstreams(
      [],
      [record('openai', { reconciliationState: 'pending', reconciledAt: null, credentialRequired: true })],
      {
        targetSlug: 'openai',
        keyOverride: { slug: 'openai', apiKey: 'sk-inflight' },
      },
    )

    expect(plan.upstreams).toEqual([{ id: 'openai', baseUrl: 'https://openai.example/v1', apiKey: 'sk-inflight', auth: AUTH }])
    expect(plan.preservedSlugs).toEqual([])
  })

  it('lets a preserved store row shadow the env upstream that shares its slug', () => {
    const plan = planStoreUpstreams(
      [
        { id: 'openai', baseUrl: 'https://env.example/v1', apiKey: 'sk-env' },
        { id: 'other', baseUrl: 'https://other.example/v1', apiKey: 'sk-other' },
      ],
      [record('openai', { reconciliationState: 'error', reconciledAt: null, credentialRequired: true })],
    )

    // Sealing the env key here would overwrite the very provider this pass must leave untouched.
    expect(plan.upstreams.map((upstream) => upstream.id)).toEqual(['other'])
    expect(plan.preservedSlugs).toEqual(['openai'])
  })
})

describe('operator ai manager lifecycle', () => {
  it('fails closed on an unknown stored state and normalizes database timestamps', async () => {
    const { manager, rows } = buildManager(IDENTITY)
    rows.set('corrupt', {
      slug: 'corrupt',
      label: 'Corrupt',
      base_url: 'https://api.example/v1',
      models: ['model'],
      context_window: 0,
      enabled: true,
      sort_order: 1,
      auth_config: AUTH,
      reconciliation_state: 'unexpected',
      reconciliation_error_code: null,
      credential_required: false,
      reconciled_at: new Date('2026-08-20T00:00:00.000Z'),
    })

    expect(await manager.list()).toEqual([
      expect.objectContaining({
        reconciliationState: 'error',
        reconciledAt: '2026-08-20T00:00:00.000Z',
      }),
    ])
  })

  it('reports unavailable and refuses writes when no identity is resolved', async () => {
    const { manager } = buildManager(null)
    expect(manager.available()).toBe(false)
    await expect(
      manager.create({
        slug: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api/v1',
        models: ['gpt-5.5'],
        contextWindow: 0,
        apiKey: 'k',
        enabled: true,
        auth: AUTH,
      }),
    ).rejects.toBeInstanceOf(OperatorAiUnavailableError)
  })

  it('seals the key, creates the resource and grant, and publishes the gateway entries on create', async () => {
    const { manager, state, getPublished } = buildManager(IDENTITY)
    const view = await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-5.5', 'gpt-5.4'],
      contextWindow: 128000,
      apiKey: 'sk-live',
      enabled: true,
      auth: AUTH,
    })
    expect(view.slug).toBe('openai')
    // The key is sealed into a provider whose config carries it, never returned in the view.
    expect((view as Record<string, unknown>).apiKey).toBeUndefined()
    expect(state.providers).toHaveLength(1)
    expect(state.providers[0].config_json.api_key).toBe('sk-live')
    expect(state.resources).toHaveLength(1)
    expect(state.policySets[0]?.active_version_id).toBeTruthy()
    // Two models on one provider yield two gateway entries sharing the sealed resource.
    expect(getPublished().map((c) => c.id)).toEqual(['openai__gpt_5_5', 'openai__gpt_5_4'])
  })

  it('keeps a failed create inert across restart until it is retried with the key', async () => {
    const first = buildManager(IDENTITY)
    first.failNext('provider.create:provider://caracal-sys-operator-llm-openai')
    await expect(
      first.manager.create({
        slug: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api/v1',
        models: ['gpt-5.5'],
        contextWindow: 0,
        apiKey: 'sk-create-secret',
        enabled: true,
        auth: AUTH,
      }),
    ).rejects.toThrow('injected failure')

    expect(first.rows.get('openai')).toMatchObject({
      reconciliation_state: 'error',
      reconciliation_error_code: 'reconciliation_failed',
      credential_required: true,
    })
    expect(first.getPublished()).toEqual([])
    expect(JSON.stringify([...first.rows.values()])).not.toContain('sk-create-secret')

    const restarted = first.restart()
    await restarted.manager.recover()
    expect(restarted.rows.get('openai')?.reconciliation_state).toBe('error')
    expect(restarted.state.providers).toEqual([])
    expect(restarted.getPublished()).toEqual([])

    const view = await restarted.manager.update('openai', { apiKey: 'sk-create-retry' })
    expect(view.reconciliationState).toBe('ready')
    expect(view.credentialRequired).toBe(false)
    expect(restarted.getPublished().map((provider) => provider.id)).toEqual(['openai'])
  })

  it('preserves but never grants a key sealed before create reconciliation fails', async () => {
    const first = buildManager(IDENTITY)
    first.failNext('resource.create:caracal-sys://operator-llm-openai')
    await expect(
      first.manager.create({
        slug: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api/v1',
        models: ['gpt-5.5'],
        contextWindow: 0,
        apiKey: 'sk-partially-sealed',
        enabled: true,
        auth: AUTH,
      }),
    ).rejects.toThrow('injected failure')

    expect(first.rows.get('openai')).toMatchObject({ reconciliation_state: 'error', credential_required: true })
    expect(first.state.providers).toHaveLength(1)
    expect(first.state.providers[0].config_json.api_key).toBe('sk-partially-sealed')
    expect(first.state.resources).toEqual([])
    expect(first.state.policySets).toEqual([])
    expect(first.getPublished()).toEqual([])

    const restarted = first.restart()
    await restarted.manager.recover()
    expect(restarted.state.providers).toHaveLength(1)
    expect(restarted.state.resources).toEqual([])
    expect(restarted.rows.get('openai')).toMatchObject({ reconciliation_state: 'error', credential_required: true })
    expect(restarted.getPublished()).toEqual([])

    await restarted.manager.update('openai', { apiKey: 'sk-explicit-retry' })
    expect(restarted.state.providers[0].config_json.api_key).toBe('sk-explicit-retry')
    expect(restarted.state.resources).toHaveLength(1)
    expect(restarted.getPublished().map((provider) => provider.id)).toEqual(['openai'])
  })

  it('keeps a failed store row shadowing an env upstream with the same slug', async () => {
    const first = buildManager(IDENTITY, undefined, [{ id: 'openai', baseUrl: 'https://env.example/v1', apiKey: 'sk-env' }])
    first.failNext('resource.create:caracal-sys://operator-llm-openai')
    await expect(
      first.manager.create({
        slug: 'openai',
        label: 'Store OpenAI',
        baseUrl: 'https://store.example/v1',
        models: ['gpt-5.5'],
        contextWindow: 0,
        apiKey: 'sk-store',
        enabled: true,
        auth: AUTH,
      }),
    ).rejects.toThrow('injected failure')

    await first.manager.create({
      slug: 'other',
      label: 'Other',
      baseUrl: 'https://other.example/v1',
      models: ['other-model'],
      contextWindow: 0,
      apiKey: 'sk-other',
      enabled: true,
      auth: AUTH,
    })

    const failedProvider = first.state.providers.find((provider) => provider.identifier.endsWith('-openai'))
    expect(failedProvider?.config_json.api_key).toBe('sk-store')
    expect(first.rows.get('openai')).toMatchObject({ reconciliation_state: 'error', credential_required: true })
    expect(first.getPublished().map((provider) => provider.id)).toEqual(['other'])
  })

  it('rejects a duplicate create without mutating the existing provider', async () => {
    const { manager, rows, state, getPublished } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'Original',
      baseUrl: 'https://original.example/v1',
      models: ['original-model'],
      contextWindow: 0,
      apiKey: 'sk-original',
      enabled: true,
      auth: AUTH,
    })

    await expect(
      manager.create({
        slug: 'openai',
        label: 'Replacement',
        baseUrl: 'https://replacement.example/v1',
        models: ['replacement-model'],
        contextWindow: 0,
        apiKey: 'sk-replacement',
        enabled: true,
        auth: AUTH,
      }),
    ).rejects.toBeInstanceOf(OperatorAiConflictError)

    expect(rows.get('openai')).toMatchObject({ label: 'Original', base_url: 'https://original.example/v1' })
    expect(state.providers[0].config_json.api_key).toBe('sk-original')
    expect(state.resources[0].upstream_url).toBe('https://original.example/v1')
    expect(getPublished().map((provider) => provider.id)).toEqual(['openai'])
  })

  it('marks migrated metadata with no sealed provider as credential-required on startup', async () => {
    const restarted = buildManager(IDENTITY)
    restarted.rows.set('legacy', {
      slug: 'legacy',
      label: 'Legacy',
      base_url: 'https://legacy.example/v1',
      models: ['legacy-model'],
      context_window: 0,
      enabled: true,
      sort_order: 1,
      auth_config: AUTH,
      reconciliation_state: 'ready',
      reconciliation_error_code: null,
      credential_required: false,
      reconciled_at: null,
    })

    expect((await restarted.manager.list())[0]).toMatchObject({ reconciliationState: 'pending', reconciledAt: null })
    await restarted.manager.recover()

    expect(restarted.rows.get('legacy')).toMatchObject({
      reconciliation_state: 'error',
      reconciliation_error_code: 'reconciliation_failed',
      credential_required: true,
    })
    expect(restarted.getPublished()).toEqual([])
  })

  it('does not repoint a migrated sealed credential when metadata and the live endpoint diverge', async () => {
    const first = buildManager(IDENTITY)
    await first.manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://old.example/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-old',
      enabled: true,
      auth: AUTH,
    })
    // Reproduce an update committed by the pre-migration metadata-first implementation. The
    // registry names the new host while the sealed resource (and its old key) still names the
    // original host, and the migrated row has no reconciliation proof.
    const row = first.rows.get('openai')!
    row.base_url = 'https://new.example/v1'
    row.reconciled_at = null

    const restarted = first.restart()
    await restarted.manager.recover()

    expect(restarted.rows.get('openai')).toMatchObject({
      reconciliation_state: 'error',
      reconciliation_error_code: 'reconciliation_failed',
      credential_required: true,
      reconciled_at: null,
    })
    expect(restarted.state.resources[0].upstream_url).toBe('https://old.example/v1')
    expect(restarted.state.providers[0].config_json.api_key).toBe('sk-old')
    expect(restarted.getPublished()).toEqual([])
  })

  it('verifies and republishes a migrated row when its sealed provider and endpoint agree', async () => {
    const first = buildManager(IDENTITY)
    await first.manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.example/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-sealed',
      enabled: true,
      auth: AUTH,
    })
    first.rows.get('openai')!.reconciled_at = null

    const restarted = first.restart()
    await restarted.manager.recover()

    expect(restarted.rows.get('openai')).toMatchObject({
      reconciliation_state: 'ready',
      reconciliation_error_code: null,
      credential_required: false,
      reconciled_at: '2026-08-20T00:00:00.000Z',
    })
    expect(restarted.getPublished().map((provider) => provider.id)).toEqual(['openai'])
  })

  it('keeps an unverified legacy row out of ordinary reconciliations after recovery fails', async () => {
    const first = buildManager(IDENTITY)
    await first.manager.create({
      slug: 'legacy',
      label: 'Legacy',
      baseUrl: 'https://legacy.example/v1',
      models: ['legacy-model'],
      contextWindow: 0,
      apiKey: 'sk-legacy',
      enabled: true,
      auth: AUTH,
    })
    const legacyRow = first.rows.get('legacy')!
    legacyRow.reconciled_at = null
    legacyRow.auth_config = { location: 'header', headerName: 'X-API-Key' }

    const restarted = first.restart()
    restarted.failNext(`provider.patch:${restarted.state.providers[0].id}`)
    await expect(restarted.manager.recover()).rejects.toThrow('injected failure')
    expect(restarted.rows.get('legacy')).toMatchObject({
      reconciliation_state: 'pending',
      credential_required: false,
      reconciled_at: null,
    })
    expect(restarted.getPublished()).toEqual([])

    await restarted.manager.create({
      slug: 'other',
      label: 'Other',
      baseUrl: 'https://other.example/v1',
      models: ['other-model'],
      contextWindow: 0,
      apiKey: 'sk-other',
      enabled: true,
      auth: AUTH,
    })
    expect(restarted.rows.get('legacy')?.reconciliation_state).toBe('pending')
    expect(restarted.state.providers.find((provider) => provider.identifier.endsWith('-legacy'))?.config_json.header_name).toBe(
      'Authorization',
    )
    expect(restarted.getPublished().map((provider) => provider.id)).toEqual(['other'])
  })

  it('places the sealed key in a custom header when the upstream wants one (Azure api-key)', async () => {
    const { manager, state } = buildManager(IDENTITY)
    await manager.create({
      slug: 'azure',
      label: 'Azure',
      baseUrl: 'https://r.azure.com',
      models: ['gpt-5.4-mini'],
      contextWindow: 0,
      apiKey: 'sk-azure',
      enabled: true,
      auth: { location: 'header', headerName: 'api-key' },
    })
    const cfg = state.providers[0].config_json
    expect(cfg.auth_location).toBe('header')
    expect(cfg.header_name).toBe('api-key')
    expect(cfg.auth_scheme).toBeUndefined()
    expect(cfg.api_key).toBe('sk-azure')
  })

  it('places the sealed key in a query parameter when configured', async () => {
    const { manager, state } = buildManager(IDENTITY)
    await manager.create({
      slug: 'qp',
      label: 'Query',
      baseUrl: 'https://api/v1',
      models: ['m'],
      contextWindow: 0,
      apiKey: 'sk-qp',
      enabled: true,
      auth: { location: 'query', queryParamName: 'key' },
    })
    const cfg = state.providers[0].config_json
    expect(cfg.auth_location).toBe('query')
    expect(cfg.query_param_name).toBe('key')
    expect(cfg.header_name).toBeUndefined()
  })

  it('edits placement without re-sealing the key', async () => {
    const { manager, state } = buildManager(IDENTITY)
    await manager.create({
      slug: 'p',
      label: 'P',
      baseUrl: 'https://api/v1',
      models: ['m'],
      contextWindow: 0,
      apiKey: 'sk-1',
      enabled: true,
      auth: AUTH,
    })
    await manager.update('p', { auth: { location: 'header', headerName: 'X-API-Key' } })
    const cfg = state.providers[0].config_json
    expect(cfg.header_name).toBe('X-API-Key')
    expect(cfg.api_key).toBe('sk-1')
  })

  it('does not re-seal the key on a metadata update', async () => {
    const { manager, state } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-1',
      enabled: true,
      auth: AUTH,
    })
    const sealedKey = state.providers[0].config_json.api_key
    await manager.update('openai', { label: 'OpenAI Prod', models: ['gpt-5.5', 'gpt-5.4'] })
    // A metadata update reconciles only public config; the sealed key is never re-supplied or lost.
    expect(state.providers[0].config_json.api_key).toBe(sealedKey)
    expect(state.providers).toHaveLength(1)
  })

  it('re-seals the key on rotate', async () => {
    const { manager, state } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-1',
      enabled: true,
      auth: AUTH,
    })
    await manager.rotateKey('openai', 'sk-2')
    expect(state.providers[0].config_json.api_key).toBe('sk-2')
  })

  it('refuses to move the endpoint without a key, so the sealed key is never re-pointed', async () => {
    const { manager, state } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-1',
      enabled: true,
      auth: AUTH,
    })
    await expect(manager.update('openai', { baseUrl: 'https://attacker.example/v1' })).rejects.toBeInstanceOf(OperatorAiKeyRequiredError)
    // The rejected edit changed nothing: the endpoint and its sealed key are both untouched.
    expect(state.providers[0].config_json.api_key).toBe('sk-1')
    expect(state.resources[0].upstream_url).toBe('https://api/v1')
  })

  it('marks a metadata-only update credential-required when the sealed provider disappeared', async () => {
    const { manager, rows, state, getPublished } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-sealed',
      enabled: true,
      auth: AUTH,
    })
    state.providers = []

    await expect(manager.update('openai', { label: 'Updated' })).rejects.toBeInstanceOf(OperatorAiKeyRequiredError)
    expect(rows.get('openai')).toMatchObject({
      label: 'Updated',
      reconciliation_state: 'error',
      reconciliation_error_code: 'reconciliation_failed',
      credential_required: true,
    })
    expect(getPublished()).toEqual([])
  })

  it('re-seals the supplied key when the endpoint moves', async () => {
    const { manager, state } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-1',
      enabled: true,
      auth: AUTH,
    })
    await manager.update('openai', { baseUrl: 'https://api-2/v1', apiKey: 'sk-2' })
    expect(state.providers[0].config_json.api_key).toBe('sk-2')
  })

  it('fails closed on a partial endpoint move and requires the key again after restart', async () => {
    const first = buildManager(IDENTITY)
    await first.manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-old',
      enabled: true,
      auth: AUTH,
    })
    const resourceId = first.state.resources[0].id
    first.failNext(`resource.patch:${resourceId}`)

    await expect(first.manager.update('openai', { baseUrl: 'https://api-2/v1', apiKey: 'sk-new' })).rejects.toThrow('injected failure')
    expect(first.rows.get('openai')).toMatchObject({
      base_url: 'https://api-2/v1',
      reconciliation_state: 'error',
      credential_required: true,
    })
    expect(first.getPublished()).toEqual([])
    expect(JSON.stringify([...first.rows.values()])).not.toContain('sk-new')
    expect(first.state.policies[0].versions).toHaveLength(2)

    const restarted = first.restart()
    await restarted.manager.recover()
    // Recovery preserves the sealed provider but does not point the old resource at the desired
    // endpoint without receiving the key again.
    expect(restarted.state.resources[0].upstream_url).toBe('https://api/v1')
    expect(restarted.rows.get('openai')?.reconciliation_state).toBe('error')
    await expect(restarted.manager.update('openai', { label: 'Still pending' })).rejects.toBeInstanceOf(OperatorAiKeyRequiredError)

    const view = await restarted.manager.update('openai', { apiKey: 'sk-new-retry' })
    expect(view.reconciliationState).toBe('ready')
    expect(restarted.state.resources[0].upstream_url).toBe('https://api-2/v1')
    expect(restarted.getPublished().map((provider) => provider.id)).toEqual(['openai'])
  })

  it('replays a metadata-only reconciliation after restart without retaining a key', async () => {
    const first = buildManager(IDENTITY)
    await first.manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-stays-sealed',
      enabled: true,
      auth: AUTH,
    })
    first.failNext(`provider.patch:${first.state.providers[0].id}`)
    await expect(first.manager.update('openai', { auth: { location: 'header', headerName: 'X-API-Key' } })).rejects.toThrow(
      'injected failure',
    )
    expect(first.rows.get('openai')).toMatchObject({ reconciliation_state: 'error', credential_required: false })

    const restarted = first.restart()
    await restarted.manager.recover()
    expect(restarted.rows.get('openai')).toMatchObject({
      reconciliation_state: 'ready',
      reconciliation_error_code: null,
      credential_required: false,
    })
    expect(restarted.state.providers[0].config_json.header_name).toBe('X-API-Key')
    expect(restarted.state.providers[0].config_json.api_key).toBe('sk-stays-sealed')
  })

  it('rejects rotate and update for an unknown provider', async () => {
    const { manager } = buildManager(IDENTITY)
    await expect(manager.rotateKey('ghost', 'k')).rejects.toBeInstanceOf(OperatorAiNotFoundError)
    await expect(manager.update('ghost', { label: 'x' })).rejects.toBeInstanceOf(OperatorAiNotFoundError)
  })

  it('prunes the sealed provider and clears the registry on delete', async () => {
    const { manager, state, getPublished } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-1',
      enabled: true,
      auth: AUTH,
    })
    const removed = await manager.remove('openai')
    expect(removed).toBe(true)
    expect(state.providers).toHaveLength(0)
    expect(getPublished()).toHaveLength(0)
  })

  it('keeps a delete tombstone and completes stale sealed-resource cleanup after restart', async () => {
    const first = buildManager(IDENTITY)
    await first.manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-delete',
      enabled: true,
      auth: AUTH,
    })
    first.failNext(`provider.delete:${first.state.providers[0].id}`)
    await expect(first.manager.remove('openai')).rejects.toThrow('injected failure')
    expect(first.rows.get('openai')).toMatchObject({
      reconciliation_state: 'deleting',
      reconciliation_error_code: 'reconciliation_failed',
    })
    expect(first.getPublished()).toEqual([])
    // The best-effort fail-closed pass already removed the provider after the injected transient
    // delete failure; the tombstone remains so a restart can durably finish the metadata side.
    expect(first.state.providers).toEqual([])

    const restarted = first.restart()
    await restarted.manager.recover()
    expect(restarted.rows.has('openai')).toBe(false)
    expect(restarted.state.providers).toEqual([])
    expect(restarted.getPublished()).toEqual([])
  })

  it('does nothing on a rotation tick once every row is reconciled', async () => {
    const { manager, state, restart } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-steady',
      enabled: true,
      auth: AUTH,
    })

    // recover() runs on every rotation tick, so a converged store must not re-seal anything.
    const steady = restart()
    state.calls.length = 0
    await steady.manager.recover()
    expect(state.calls).toEqual([])
  })

  it('refuses to edit or rotate a tombstone back into a live sealed endpoint', async () => {
    const { manager, rows, state, getPublished, failNext } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-doomed',
      enabled: true,
      auth: AUTH,
    })
    failNext(`provider.delete:${state.providers[0].id}`)
    await expect(manager.remove('openai')).rejects.toThrow('injected failure')
    expect(rows.get('openai')?.reconciliation_state).toBe('deleting')

    // Only a retried delete may act on a tombstone; a key supplied here would re-seal a
    // credential for an endpoint the operator already asked to destroy.
    await expect(manager.rotateKey('openai', 'sk-resurrected')).rejects.toBeInstanceOf(OperatorAiNotFoundError)
    await expect(manager.update('openai', { label: 'Resurrected', apiKey: 'sk-resurrected' })).rejects.toBeInstanceOf(
      OperatorAiNotFoundError,
    )

    expect(rows.get('openai')).toMatchObject({ label: 'OpenAI', reconciliation_state: 'deleting' })
    expect(state.providers).toEqual([])
    expect(getPublished()).toEqual([])
    expect(await manager.remove('openai')).toBe(true)
    expect(rows.has('openai')).toBe(false)
  })

  it('cleans a stale sealed provider when legacy partial deletion already removed metadata', async () => {
    const { manager, rows, state, getPublished } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-delete',
      enabled: true,
      auth: AUTH,
    })
    // Reproduce the pre-tombstone failure mode from an older process: metadata disappeared while
    // the sealed provider and its grant survived.
    rows.delete('openai')

    expect(await manager.remove('openai')).toBe(false)
    expect(state.providers).toEqual([])
    expect(getPublished()).toEqual([])
  })

  it('lists configured providers without keys', async () => {
    const { manager } = buildManager(IDENTITY)
    await manager.create({
      slug: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api/v1',
      models: ['gpt-5.5'],
      contextWindow: 0,
      apiKey: 'sk-1',
      enabled: true,
      auth: AUTH,
    })
    const list = await manager.list()
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('apiKey')
    expect(list[0].slug).toBe('openai')
    expect(list[0]).toMatchObject({ reconciliationState: 'ready', reconciliationErrorCode: null, credentialRequired: false })
  })
})
