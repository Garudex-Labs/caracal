// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the runtime governed model-provider manager and its pure registry helpers.

import { describe, it, expect } from 'vitest'
import type { AdminClient } from '@caracalai/admin'
import type { Queryable } from '../../../../apps/api/src/db.js'
import type { OperatorLlmTransport } from '../../../../apps/api/src/operator-llm-transport.js'
import {
  createOperatorAiManager,
  buildStoreProviderConfigs,
  mergeDesiredUpstreams,
  providerConfigId,
  OperatorAiUnavailableError,
  OperatorAiNotFoundError,
} from '../../../../apps/api/src/operator-ai-manager.js'
import type { ProviderConfig } from '../../../../apps/api/src/operator-gateway.js'

interface StoreRow {
  slug: string
  label: string
  base_url: string
  models: string[]
  context_window: number
  enabled: boolean
  sort_order: number
  auth_config: unknown
}

// An in-memory Queryable matching the store's four statements by their stable SQL shape, so the
// manager exercises the real store parameter mapping without a live database.
function fakeDb(): { db: Queryable; rows: Map<string, StoreRow> } {
  const rows = new Map<string, StoreRow>()
  let order = 0
  const db: Queryable = {
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> => {
      if (sql.includes('INSERT INTO operator_ai_providers')) {
        const [slug, label, baseUrl, modelsJson, ctx, enabled, authJson] = params as [
          string,
          string,
          string,
          string,
          number,
          boolean,
          string,
        ]
        const existing = rows.get(slug)
        const row: StoreRow = {
          slug,
          label,
          base_url: baseUrl,
          models: JSON.parse(modelsJson),
          context_window: ctx,
          enabled,
          sort_order: existing?.sort_order ?? ++order,
          auth_config: JSON.parse(authJson),
        }
        rows.set(slug, row)
        return { rows: [row] as T[] }
      }
      if (sql.includes('DELETE FROM operator_ai_providers')) {
        const [slug] = params as [string]
        const had = rows.delete(slug)
        return { rows: (had ? [{ slug }] : []) as T[] }
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
    gateway_application_id?: string | null
    operation_enforcement?: string
  }[]
  policies: { id: string; name: string; versions: { id: string; version: number; content_sha256: string }[] }[]
  policySets: { id: string; name: string; active_version_id: string | null }[]
  calls: string[]
}

function fakeAdmin(): { admin: AdminClient; state: AdminState } {
  const state: AdminState = { providers: [], resources: [], policies: [], policySets: [], calls: [] }
  let counter = 0
  const id = (p: string): string => `${p}-${++counter}`
  const admin = {
    providers: {
      list: async () => state.providers,
      create: async (_z: string, input: { identifier: string; config_json: Record<string, unknown> }) => {
        state.calls.push(`provider.create:${input.identifier}`)
        const provider = { id: id('prov'), identifier: input.identifier, config_json: input.config_json }
        state.providers.push(provider)
        return provider
      },
      patch: async (_z: string, pid: string, input: { config_json?: Record<string, unknown> }) => {
        state.calls.push(`provider.patch:${pid}`)
        const provider = state.providers.find((p) => p.id === pid)!
        // Mirror real PATCH: public config is replaced, the sealed key persists unless re-supplied.
        if (input.config_json) {
          const priorKey = provider.config_json.api_key
          provider.config_json = { ...input.config_json, ...(input.config_json.api_key ? {} : priorKey ? { api_key: priorKey } : {}) }
        }
        return provider
      },
      delete: async (_z: string, pid: string) => {
        state.calls.push(`provider.delete:${pid}`)
        state.providers = state.providers.filter((p) => p.id !== pid)
      },
    },
    resources: {
      list: async () => state.resources,
      create: async (_z: string, input: AdminState['resources'][number]) => {
        state.calls.push(`resource.create:${input.identifier}`)
        const resource = { ...input, id: id('res') }
        state.resources.push(resource)
        return resource
      },
      patch: async (_z: string, rid: string, input: Partial<AdminState['resources'][number]>) => {
        state.calls.push(`resource.patch:${rid}`)
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
        return { activated: true, version_id: versionId, shadow_version_id: null }
      },
    },
  }
  return { admin: admin as unknown as AdminClient, state }
}

// A transport double whose governedFetch records the resource it is bound to, so a test can
// confirm the gateway entries route through the right minted-mandate fetch.
function fakeTransport(): OperatorLlmTransport {
  return {
    governedFetch: (resourceIdentifier: string, _upstream?: string) => {
      const fn = (async () => new Response('{}')) as unknown as typeof fetch
      ;(fn as unknown as { resourceIdentifier: string }).resourceIdentifier = resourceIdentifier
      return fn
    },
  }
}

const AUTH = { location: 'header' as const, headerName: 'Authorization', authScheme: 'Bearer' }
const IDENTITY = { applicationId: 'op-app', clientSecret: 'secret', zoneId: 'sys-zone' }

function buildManager(identity: typeof IDENTITY | null) {
  const { db } = fakeDb()
  const { admin, state } = fakeAdmin()
  let published: ProviderConfig[] = []
  const manager = createOperatorAiManager({
    db,
    admin,
    resolveIdentity: () => identity,
    envUpstreams: [],
    gatewayUrl: 'http://gateway',
    proxyUrl: 'http://litellm:4000/v1',
    transport: fakeTransport(),
    onRegistryChange: (configs) => {
      published = configs
    },
  })
  return { manager, state, getPublished: () => published }
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
        },
      ],
      new Map([['openai', 'caracal-sys://operator-llm-openai']]),
      'http://gateway',
      fakeTransport(),
    )
    expect(configs).toHaveLength(2)
    expect(configs.map((c) => c.id)).toEqual(['openai__a', 'openai__b'])
    expect(configs.every((c) => c.baseUrl === 'http://gateway')).toBe(true)
  })

  it('skips a disabled provider and one whose resource did not resolve', () => {
    const disabled = buildStoreProviderConfigs(
      [{ slug: 'x', label: 'X', baseUrl: 'u', models: ['m'], contextWindow: 0, enabled: false, sortOrder: 1, auth: AUTH }],
      new Map([['x', 'res']]),
      'http://gateway',
      fakeTransport(),
    )
    expect(disabled).toHaveLength(0)
    const unresolved = buildStoreProviderConfigs(
      [{ slug: 'x', label: 'X', baseUrl: 'u', models: ['m'], contextWindow: 0, enabled: true, sortOrder: 1, auth: AUTH }],
      new Map(),
      'http://gateway',
      fakeTransport(),
    )
    expect(unresolved).toHaveLength(0)
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
        },
      ],
      'http://litellm:4000/v1',
      { slug: 'openai', apiKey: 'new-key' },
    )
    expect(merged).toHaveLength(1)
    // The resource points at the proxy; the store endpoint travels separately as a per-call header.
    expect(merged[0]).toEqual({ id: 'openai', baseUrl: 'http://litellm:4000/v1', apiKey: 'new-key', auth: AUTH })
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
        },
      ],
      'http://litellm:4000/v1',
    )
    expect(merged[0].apiKey).toBeUndefined()
  })
})

describe('operator ai manager lifecycle', () => {
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
  })
})
