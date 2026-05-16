// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// View factories for every admin resource: lists with mutation actions plus details.

import type {
  AdminClient,
  AgentSession,
  Application,
  ApplicationInput,
  AuditQuery,
  Grant,
  Policy,
  PolicySet,
  Provider,
  ProviderInput,
  Resource,
  ResourceInput,
  Session,
  SessionQuery,
  DelegationEdge,
  TraverseNode,
  Zone,
} from '@caracalai/admin'
import { readFileSync } from 'node:fs'
import type { App, View } from '../screen.ts'
import { AuditTailView } from './audit.ts'
import { DetailView } from './detail.ts'
import { ConfirmView, FormView } from './form.ts'
import { ListView } from './list.ts'

export interface Ctx {
  client: AdminClient
  zoneId: string
  onZoneSelect?: (id: string, slug: string) => void
}

function detail(title: string, load: () => Promise<unknown>): DetailView {
  return new DetailView({ title, load })
}

function open(app: App, view: View): void { app.push(view) }

function splitList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0)
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined
  return v === 'true'
}

function readFileOrInline(filePath: string, inline: string): string {
  if (filePath && filePath.length > 0) return readFileSync(filePath, 'utf8')
  return inline
}

function int(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n < 1) throw new Error('limit must be a positive integer')
  return n
}

async function popAndReload(app: App, list: ListView<unknown>): Promise<void> {
  app.pop()
  await list.reload()
}

export function zonesView(ctx: Ctx): View {
  const list: ListView<Zone> = new ListView<Zone>({
    title: 'zones',
    columns: [
      { header: 'slug', width: 18, value: (r) => r.slug },
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'login_flow', width: 12, value: (r) => r.login_flow },
      { header: 'dcr', width: 5, value: (r) => (r.dcr_enabled ? 'yes' : 'no') },
      { header: 'pkce', width: 5, value: (r) => (r.pkce_required ? 'req' : 'opt') },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.zones.list(),
    onEnter: (app, row) => {
      ctx.onZoneSelect?.(row.id, row.slug)
      app.setStatus(`zone set to ${row.slug}`)
      open(app, detail(`zone / ${row.slug}`, () => ctx.client.zones.get(row.id)))
    },
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create zone',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            { key: 'slug', label: 'slug', kind: 'text' },
            { key: 'org_id', label: 'org_id', kind: 'text' },
            { key: 'dcr_enabled', label: 'dcr', kind: 'bool', default: 'false' },
            { key: 'pkce_required', label: 'pkce', kind: 'bool', default: 'true' },
            { key: 'login_flow', label: 'login_flow', kind: 'text' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.zones.create({
              name: v.name!,
              slug: v.slug || undefined,
              org_id: v.org_id || undefined,
              dcr_enabled: bool(v.dcr_enabled),
              pkce_required: bool(v.pkce_required),
              login_flow: v.login_flow || undefined,
            })
            await popAndReload(app, list as unknown as ListView<unknown>)
          },
        }),
      },
      {
        key: 'e', label: 'edit', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `edit ${row.slug}`,
            fields: [
              { key: 'name', label: 'name', kind: 'text', default: row.name },
              { key: 'slug', label: 'slug', kind: 'text', default: row.slug },
              { key: 'dcr_enabled', label: 'dcr', kind: 'bool', default: String(row.dcr_enabled) },
              { key: 'pkce_required', label: 'pkce', kind: 'bool', default: String(row.pkce_required) },
              { key: 'login_flow', label: 'login_flow', kind: 'text', default: row.login_flow },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.zones.patch(row.id, {
                name: v.name || undefined,
                slug: v.slug || undefined,
                dcr_enabled: bool(v.dcr_enabled),
                pkce_required: bool(v.pkce_required),
                login_flow: v.login_flow || undefined,
              })
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'd', label: 'delete', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `delete zone ${row.slug}?`,
            onConfirm: async (app) => {
              await ctx.client.zones.delete(row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

export function applicationsView(ctx: Ctx): View {
  const list: ListView<Application> = new ListView<Application>({
    title: 'applications',
    columns: [
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'method', width: 8, value: (r) => r.registration_method },
      { header: 'cred', width: 12, value: (r) => r.credential_type },
      { header: 'traits', width: 24, value: (r) => (r.traits ?? []).join(',') || '-' },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.applications.list(ctx.zoneId),
    onEnter: (app, row) => open(app, detail(`app / ${row.name}`, () => ctx.client.applications.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create application',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            { key: 'registration_method', label: 'method', kind: 'select', options: ['managed', 'dcr'], default: 'managed' },
            { key: 'credential_type', label: 'credential_type', kind: 'select', options: ['token', 'password', 'public-key', 'url', 'public'], default: 'token' },
            { key: 'client_secret', label: 'client_secret', kind: 'secret' },
            { key: 'traits', label: 'traits (csv)', kind: 'list' },
            { key: 'consent', label: 'consent', kind: 'bool', default: 'false' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.applications.create(ctx.zoneId, {
              name: v.name!,
              registration_method: (v.registration_method as 'managed' | 'dcr') ?? 'managed',
              credential_type: (v.credential_type as 'token' | 'password' | 'public-key' | 'url' | 'public') || undefined,
              client_secret: v.client_secret || undefined,
              traits: v.traits ? splitList(v.traits) : undefined,
              consent: bool(v.consent),
            })
            await popAndReload(app, list as unknown as ListView<unknown>)
          },
        }),
      },
      {
        key: 'e', label: 'edit', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `edit ${row.name}`,
            fields: [
              { key: 'name', label: 'name', kind: 'text', default: row.name },
              { key: 'credential_type', label: 'credential_type', kind: 'select', options: ['token', 'password', 'public-key', 'url', 'public'], default: row.credential_type },
              { key: 'client_secret', label: 'client_secret', kind: 'secret' },
              { key: 'traits', label: 'traits (csv)', kind: 'list', default: (row.traits ?? []).join(',') },
              { key: 'consent', label: 'consent', kind: 'bool', default: String(row.consent === 'true') },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.applications.patch(ctx.zoneId, row.id, {
                name: v.name || undefined,
                credential_type: (v.credential_type as 'token' | 'password' | 'public-key' | 'url' | 'public') || undefined,
                client_secret: v.client_secret || undefined,
                traits: v.traits ? splitList(v.traits) : undefined,
                consent: bool(v.consent),
              } as Partial<ApplicationInput>)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'd', label: 'delete', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `delete application ${row.name}?`,
            onConfirm: async (app) => {
              await ctx.client.applications.delete(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'D', label: 'dcr', build: (row) => {
          return new FormView({
            title: 'dynamic client registration',
            fields: [
              { key: 'name', label: 'name', kind: 'text', required: true, default: row?.name ?? '' },
              { key: 'credential_type', label: 'credential_type', kind: 'select', options: ['token', 'password', 'public-key', 'url', 'public'], default: row?.credential_type ?? 'token' },
              { key: 'client_secret', label: 'client_secret', kind: 'secret' },
              { key: 'traits', label: 'traits (csv)', kind: 'list', default: (row?.traits ?? []).join(',') },
              { key: 'expires_in', label: 'expires_in', kind: 'text', validate: (v) => v && !Number.isFinite(Number.parseInt(v, 10)) ? 'expires_in must be an integer' : undefined },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.applications.dcr(ctx.zoneId, {
                name: v.name!,
                credential_type: (v.credential_type as ApplicationInput['credential_type']) || undefined,
                client_secret: v.client_secret || undefined,
                traits: v.traits ? splitList(v.traits) : undefined,
                expires_in: int(v.expires_in),
              })
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

export function resourcesView(ctx: Ctx): View {
  const list: ListView<Resource> = new ListView<Resource>({
    title: 'resources',
    columns: [
      { header: 'identifier', width: 32, value: (r) => r.identifier },
      { header: 'name', width: 18, value: (r) => r.name ?? '-' },
      { header: 'upstream', width: 32, value: (r) => r.upstream_url ?? '-' },
      { header: 'scopes', value: (r) => (r.scopes ?? []).join(' ') || '-' },
    ],
    load: () => ctx.client.resources.list(ctx.zoneId),
    onEnter: (app, row) => open(app, detail(`resource / ${row.identifier}`, () => ctx.client.resources.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create resource',
          fields: [
            { key: 'identifier', label: 'identifier', kind: 'text', required: true },
            { key: 'scopes', label: 'scopes (csv)', kind: 'list', required: true },
            { key: 'name', label: 'name', kind: 'text' },
            { key: 'upstream_url', label: 'upstream_url', kind: 'text' },
            { key: 'prefix', label: 'prefix', kind: 'bool', default: 'false' },
            { key: 'credential_provider_id', label: 'provider', kind: 'text' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.resources.create(ctx.zoneId, {
              identifier: v.identifier!,
              scopes: splitList(v.scopes ?? ''),
              name: v.name || undefined,
              upstream_url: v.upstream_url || undefined,
              prefix: bool(v.prefix),
              credential_provider_id: v.credential_provider_id || undefined,
            })
            await popAndReload(app, list as unknown as ListView<unknown>)
          },
        }),
      },
      {
        key: 'e', label: 'edit', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `edit ${row.identifier}`,
            fields: [
              { key: 'name', label: 'name', kind: 'text', default: row.name ?? '' },
              { key: 'identifier', label: 'identifier', kind: 'text', default: row.identifier },
              { key: 'upstream_url', label: 'upstream_url', kind: 'text', default: row.upstream_url ?? '' },
              { key: 'prefix', label: 'prefix', kind: 'bool', default: String(row.prefix) },
              { key: 'scopes', label: 'scopes (csv)', kind: 'list', default: (row.scopes ?? []).join(',') },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.resources.patch(ctx.zoneId, row.id, {
                name: v.name || undefined,
                identifier: v.identifier || undefined,
                upstream_url: v.upstream_url || undefined,
                prefix: bool(v.prefix),
                scopes: v.scopes ? splitList(v.scopes) : undefined,
              } as Partial<ResourceInput>)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'd', label: 'delete', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `delete resource ${row.identifier}?`,
            onConfirm: async (app) => {
              await ctx.client.resources.delete(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

export function providersView(ctx: Ctx): View {
  const list: ListView<Provider> = new ListView<Provider>({
    title: 'providers',
    columns: [
      { header: 'identifier', width: 24, value: (r) => r.identifier },
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'kind', width: 10, value: (r) => r.kind ?? '-' },
      { header: 'owner', width: 10, value: (r) => r.owner_type },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.providers.list(ctx.zoneId),
    onEnter: (app, row) => open(app, detail(`provider / ${row.identifier}`, () => ctx.client.providers.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create provider',
          fields: [
            { key: 'identifier', label: 'identifier', kind: 'text', required: true },
            { key: 'name', label: 'name', kind: 'text' },
            { key: 'kind', label: 'kind', kind: 'select', options: ['oauth2', 'oidc', 'apikey', 'workload'], default: 'oauth2' },
            { key: 'config_json', label: 'config_json', kind: 'multiline' },
            { key: 'owner_type', label: 'owner_type', kind: 'text' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.providers.create(ctx.zoneId, {
              identifier: v.identifier!,
              name: v.name || undefined,
              kind: (v.kind as 'oauth2' | 'oidc' | 'apikey' | 'workload') || undefined,
              config_json: v.config_json ? JSON.parse(v.config_json) : undefined,
              owner_type: v.owner_type || undefined,
            })
            await popAndReload(app, list as unknown as ListView<unknown>)
          },
        }),
      },
      {
        key: 'e', label: 'edit', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `edit ${row.identifier}`,
            fields: [
              { key: 'name', label: 'name', kind: 'text', default: row.name },
              { key: 'identifier', label: 'identifier', kind: 'text', default: row.identifier },
              { key: 'kind', label: 'kind', kind: 'select', options: ['oauth2', 'oidc', 'apikey', 'workload'], default: row.kind ?? 'oauth2' },
              { key: 'config_json', label: 'config_json', kind: 'multiline', default: JSON.stringify(row.config_json ?? {}) },
              { key: 'owner_type', label: 'owner_type', kind: 'text', default: row.owner_type },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.providers.patch(ctx.zoneId, row.id, {
                name: v.name || undefined,
                identifier: v.identifier || undefined,
                kind: (v.kind as 'oauth2' | 'oidc' | 'apikey' | 'workload') || undefined,
                config_json: v.config_json ? JSON.parse(v.config_json) : undefined,
                owner_type: v.owner_type || undefined,
              } as Partial<ProviderInput>)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'd', label: 'delete', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `delete provider ${row.identifier}?`,
            onConfirm: async (app) => {
              await ctx.client.providers.delete(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

export function policiesView(ctx: Ctx): View {
  const list: ListView<Policy> = new ListView<Policy>({
    title: 'policies',
    columns: [
      { header: 'name', width: 28, value: (r) => r.name },
      { header: 'owner', width: 10, value: (r) => r.owner_type },
      { header: 'description', width: 32, value: (r) => r.description ?? '-' },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.policies.list(ctx.zoneId),
    onEnter: (app, row) => open(app, detail(`policy / ${row.name}`, () => ctx.client.policies.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create policy',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            { key: 'description', label: 'description', kind: 'text' },
            { key: 'owner_type', label: 'owner_type', kind: 'text' },
            { key: 'file', label: 'file (ctrl-o)', kind: 'file' },
            { key: 'content', label: 'content', kind: 'multiline' },
            { key: 'schema_version', label: 'schema_version', kind: 'text' },
          ],
          onSubmit: async (v, app) => {
            const content = readFileOrInline(v.file ?? '', v.content ?? '')
            if (!content) throw new Error('file or content required')
            await ctx.client.policies.create(ctx.zoneId, {
              name: v.name!,
              description: v.description || undefined,
              owner_type: v.owner_type || undefined,
              content,
              schema_version: v.schema_version || undefined,
            })
            await popAndReload(app, list as unknown as ListView<unknown>)
          },
        }),
      },
      {
        key: 'v', label: 'version', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `version ${row.name}`,
            fields: [
              { key: 'file', label: 'file (ctrl-o)', kind: 'file' },
              { key: 'content', label: 'content', kind: 'multiline' },
              { key: 'schema_version', label: 'schema_version', kind: 'text' },
            ],
            onSubmit: async (v, app) => {
              const content = readFileOrInline(v.file ?? '', v.content ?? '')
              if (!content) throw new Error('file or content required')
              await ctx.client.policies.addVersion(ctx.zoneId, row.id, content, v.schema_version || undefined)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'd', label: 'delete', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `delete policy ${row.name}?`,
            onConfirm: async (app) => {
              await ctx.client.policies.delete(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

export function policySetsView(ctx: Ctx): View {
  const list: ListView<PolicySet> = new ListView<PolicySet>({
    title: 'policy-sets',
    columns: [
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'active_version', width: 36, value: (r) => r.active_version_id ?? '(none)' },
      { header: 'description', value: (r) => r.description ?? '-' },
    ],
    load: () => ctx.client.policySets.list(ctx.zoneId),
    onEnter: (app, row) => open(app, detail(`policy-set / ${row.name}`, () => ctx.client.policySets.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create policy-set',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            { key: 'description', label: 'description', kind: 'text' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.policySets.create(ctx.zoneId, v.name!, v.description || undefined)
            await popAndReload(app, list as unknown as ListView<unknown>)
          },
        }),
      },
      {
        key: 'v', label: 'version', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `version ${row.name}`,
            fields: [
              { key: 'policy_versions', label: 'versions (csv)', kind: 'list', required: true },
            ],
            onSubmit: async (v, app) => {
              const manifest = splitList(v.policy_versions ?? '').map((policy_version_id) => ({ policy_version_id }))
              await ctx.client.policySets.addVersion(ctx.zoneId, row.id, manifest)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'a', label: 'activate', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `activate ${row.name}`,
            fields: [
              { key: 'version_id', label: 'version_id', kind: 'text', required: true },
              { key: 'shadow_version_id', label: 'shadow_version_id', kind: 'text' },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.policySets.activate(ctx.zoneId, row.id, v.version_id!, v.shadow_version_id || undefined)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'd', label: 'delete', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `delete policy-set ${row.name}?`,
            onConfirm: async (app) => {
              await ctx.client.policySets.delete(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

export function grantsView(ctx: Ctx): View {
  const list: ListView<Grant> = new ListView<Grant>({
    title: 'grants',
    columns: [
      { header: 'app', width: 36, value: (r) => r.application_id },
      { header: 'user', width: 36, value: (r) => r.user_id },
      { header: 'resource', width: 36, value: (r) => r.resource_id },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'scopes', value: (r) => (r.scopes ?? []).join(' ') || '-' },
    ],
    load: () => ctx.client.grants.list(ctx.zoneId),
    onEnter: (app, row) => open(app, detail(`grant / ${row.id}`, () => ctx.client.grants.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create grant',
          fields: [
            { key: 'application_id', label: 'app', kind: 'text', required: true },
            { key: 'user_id', label: 'user', kind: 'text', required: true },
            { key: 'resource_id', label: 'resource', kind: 'text', required: true },
            { key: 'scopes', label: 'scopes (csv)', kind: 'list', required: true },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.grants.create(ctx.zoneId, {
              application_id: v.application_id!,
              user_id: v.user_id!,
              resource_id: v.resource_id!,
              scopes: splitList(v.scopes ?? ''),
            })
            await popAndReload(app, list as unknown as ListView<unknown>)
          },
        }),
      },
      {
        key: 'k', label: 'revoke', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `revoke grant ${row.id}?`,
            onConfirm: async (app) => {
              await ctx.client.grants.revoke(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

export function sessionsView(ctx: Ctx): View {
  const filters: SessionQuery = {}
  const list: ListView<Session> = new ListView<Session>({
    title: 'sessions',
    columns: [
      { header: 'subject', width: 36, value: (r) => r.subject_id },
      { header: 'type', width: 10, value: (r) => r.session_type },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'expires_at', width: 24, value: (r) => r.expires_at },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.sessions.list(ctx.zoneId, filters),
    actions: [
      {
        key: 'f', label: 'filter', build: () => {
          return new FormView({
            title: 'filter sessions',
            fields: [
              { key: 'status', label: 'status', kind: 'select', options: ['', 'active', 'revoked', 'expired'], default: filters.status ?? '' },
              { key: 'subject_id', label: 'subject', kind: 'text', default: filters.subject_id ?? '' },
              { key: 'limit', label: 'limit', kind: 'text', default: filters.limit === undefined ? '' : String(filters.limit), validate: (v) => v ? (Number.isFinite(Number.parseInt(v, 10)) ? undefined : 'limit must be an integer') : undefined },
            ],
            onSubmit: async (v, app) => {
              filters.status = (v.status as SessionQuery['status']) || undefined
              filters.subject_id = v.subject_id || undefined
              filters.limit = int(v.limit)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

export function delegationsView(ctx: Ctx): View {
  return new DelegationMenuView(ctx)
}

class DelegationMenuView implements View {
  readonly title = 'delegations'
  private cursor = 0
  private readonly items = [
    { key: 'i', label: 'inbound', build: () => this.edgeForm('inbound') },
    { key: 'o', label: 'outbound', build: () => this.edgeForm('outbound') },
    { key: 't', label: 'traverse', build: () => this.traverseForm() },
    { key: 'r', label: 'revoke', build: () => this.revokeForm() },
  ]

  private readonly ctx: Ctx
  constructor(ctx: Ctx) { this.ctx = ctx }

  hints(): string[] { return ['↑/↓:select', 'enter:open', 'esc:back'] }

  render(): string[] {
    const lines = ['', ' Delegations', '']
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!
      lines.push(`${i === this.cursor ? '> ' : '  '}[${item.key}] ${item.label}`)
    }
    return lines
  }

  async onKey(key: string, ctx: { app: App }): Promise<void> {
    if (key === 'up' || key === 'k') { this.cursor = Math.max(0, this.cursor - 1); return }
    if (key === 'down' || key === 'j') { this.cursor = Math.min(this.items.length - 1, this.cursor + 1); return }
    if (key === 'left' || key === 'esc') { ctx.app.pop(); return }
    const direct = this.items.findIndex((item) => item.key === key)
    if (direct >= 0) { ctx.app.push(this.items[direct]!.build()); return }
    if (key === 'enter') ctx.app.push(this.items[this.cursor]!.build())
  }

  private edgeForm(kind: 'inbound' | 'outbound'): View {
    return new FormView({
      title: `delegation ${kind}`,
      fields: [{ key: 'session_id', label: 'session_id', kind: 'text', required: true }],
      onSubmit: async (v, app) => {
        app.pop()
        app.push(delegationEdgesView(this.ctx, kind, v.session_id!))
      },
    })
  }

  private traverseForm(): View {
    return new FormView({
      title: 'delegation traverse',
      fields: [{ key: 'edge_id', label: 'edge_id', kind: 'text', required: true }],
      onSubmit: async (v, app) => {
        app.pop()
        app.push(delegationTraverseView(this.ctx, v.edge_id!))
      },
    })
  }

  private revokeForm(): View {
    return new FormView({
      title: 'delegation revoke',
      fields: [{ key: 'edge_id', label: 'edge_id', kind: 'text', required: true }],
      onSubmit: async (v, app) => {
        const result = await this.ctx.client.delegations.revoke(this.ctx.zoneId, v.edge_id!)
        app.pop()
        app.push(detail(`delegation / ${v.edge_id}`, async () => result))
      },
    })
  }
}

function delegationEdgesView(ctx: Ctx, kind: 'inbound' | 'outbound', sessionId: string): ListView<DelegationEdge> {
  const list: ListView<DelegationEdge> = new ListView<DelegationEdge>({
    title: `delegations / ${kind}`,
    columns: [
      { header: 'source', width: 36, value: (r) => r.source_session_id },
      { header: 'target', width: 36, value: (r) => r.target_session_id },
      { header: 'resource', width: 24, value: (r) => r.resource_id ?? '-' },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => kind === 'inbound'
      ? ctx.client.delegations.inbound(ctx.zoneId, sessionId)
      : ctx.client.delegations.outbound(ctx.zoneId, sessionId),
    onEnter: (app, row) => open(app, detail(`delegation / ${row.id}`, async () => row)),
    actions: [
      {
        key: 't', label: 'traverse', build: (row) => {
          if (!row) throw new Error('no row selected')
          return delegationTraverseView(ctx, row.id)
        },
      },
      {
        key: 'k', label: 'revoke', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `revoke delegation ${row.id}?`,
            onConfirm: async (app) => {
              await ctx.client.delegations.revoke(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
    ],
  })
  return list
}

function delegationTraverseView(ctx: Ctx, id: string): ListView<TraverseNode> {
  return new ListView<TraverseNode>({
    title: `delegation traverse / ${id}`,
    columns: [
      { header: 'depth', width: 6, value: (r) => String(r.depth) },
      { header: 'source', width: 36, value: (r) => r.source_session_id },
      { header: 'target', width: 36, value: (r) => r.target_session_id },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.delegations.traverse(ctx.zoneId, id),
    onEnter: (app, row) => open(app, detail(`delegation-node / ${row.id}`, async () => row)),
  })
}

export function agentsView(ctx: Ctx): View {
  const list: ListView<AgentSession> = new ListView<AgentSession>({
    title: 'agents',
    columns: [
      { header: 'application', width: 36, value: (r) => r.application_id },
      { header: 'parent', width: 36, value: (r) => r.parent_id ?? '-' },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'depth', width: 6, value: (r) => String(r.depth) },
      { header: 'spawned_at', width: 24, value: (r) => r.spawned_at },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.agents.list(ctx.zoneId),
    onEnter: (app, row) => open(app, detail(`agent / ${row.id}`, () => ctx.client.agents.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 's', label: 'suspend', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `suspend agent ${row.id}?`,
            onConfirm: async (app) => {
              await ctx.client.agents.suspend(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'r', label: 'resume', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `resume agent ${row.id}?`,
            onConfirm: async (app) => {
              await ctx.client.agents.resume(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 't', label: 'terminate', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `terminate agent ${row.id}?`,
            onConfirm: async (app) => {
              await ctx.client.agents.terminate(ctx.zoneId, row.id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'T', label: 'tree', build: (row) => {
          if (!row) throw new Error('no row selected')
          return detail(`agent-tree / ${row.id}`, () => ctx.client.agents.children(ctx.zoneId, row.id))
        },
      },
    ],
  })
  return list
}

export function auditView(ctx: Ctx): View {
  const filters: AuditQuery = {}
  return new FormView({
    title: 'audit filters',
    submitLabel: 'tail',
    fields: [
      { key: 'decision', label: 'decision', kind: 'select', options: ['', 'allow', 'deny', 'partial'] },
      { key: 'since', label: 'since', kind: 'text' },
      { key: 'until', label: 'until', kind: 'text' },
      { key: 'request_id', label: 'request_id', kind: 'text' },
      { key: 'event_type', label: 'event_type', kind: 'text' },
      { key: 'limit', label: 'limit', kind: 'text', default: '100', validate: (v) => v ? (Number.isFinite(Number.parseInt(v, 10)) ? undefined : 'limit must be an integer') : undefined },
    ],
    onSubmit: async (v, app) => {
      filters.decision = (v.decision as AuditQuery['decision']) || undefined
      filters.since = v.since || undefined
      filters.until = v.until || undefined
      filters.request_id = v.request_id || undefined
      filters.event_type = v.event_type || undefined
      filters.limit = int(v.limit)
      app.pop()
      app.push(new AuditTailView(ctx.client, ctx.zoneId, filters))
    },
  })
}
