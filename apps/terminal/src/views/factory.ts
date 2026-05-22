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
  CredentialType,
  Grant,
  Policy,
  PolicyVersion,
  PolicySet,
  Provider,
  ProviderInput,
  ProviderKind,
  Resource,
  ResourceInput,
  Session,
  SessionQuery,
  DelegationEdge,
  TraverseNode,
  Zone,
} from '@caracalai/admin'
import type { JsonObject } from '@caracalai/core'
import { readFileSync } from 'node:fs'
import type { App, View } from '../screen.ts'
import type { TuiStateStore } from '../state.ts'
import { maskSecretField } from '../errors.ts'
import { AuditTailView } from './audit.ts'
import { DetailView } from './detail.ts'
import { ConfirmView, FormView, type Field } from './form.ts'
import { ListView } from './list.ts'
import { appendCsv, pickFromList } from './picker.ts'

export interface Ctx {
  client: AdminClient
  zoneId: string
  onZoneSelect?: (id: string, slug: string) => void
  state?: TuiStateStore | undefined
}

function detail(title: string, load: () => Promise<unknown>): DetailView {
  return new DetailView({ title, load, mask: maskSecretField })
}

function open(app: App, view: View): void { app.push(view) }

function splitList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0)
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined
  return v === 'true'
}

const CREDENTIAL_TYPES: CredentialType[] = ['public', 'token', 'password', 'public-key', 'url']
const PROVIDER_KINDS: ProviderKind[] = ['oauth2', 'oidc', 'apikey', 'workload']

function readFileOrInline(filePath: string, inline: string): string {
  if (filePath && filePath.length > 0) return readFileSync(filePath, 'utf8')
  return inline
}

function parseJsonObject(input: string): JsonObject {
  const parsed = JSON.parse(input) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be a JSON object')
  return parsed as JsonObject
}

function providerConfig(filePath: string, inline: string): JsonObject | undefined {
  const content = readFileOrInline(filePath, inline)
  return content.trim().length > 0 ? parseJsonObject(content) : undefined
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

export function applicationPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Application>(
    'pick application',
    () => ctx.client.applications.list(ctx.zoneId),
    [
      { header: 'name', width: 24, value: (row) => row.name },
      { header: 'credential', width: 12, value: (row) => row.credential_type },
      { header: 'id', value: (row) => row.id },
    ],
    (row) => row.id,
    (row) => row.name,
  )
}

function resourcePicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Resource>(
    'pick resource',
    () => ctx.client.resources.list(ctx.zoneId),
    [
      { header: 'identifier', width: 30, value: (row) => row.identifier },
      { header: 'scopes', width: 28, value: (row) => (row.scopes ?? []).join(',') || '-' },
      { header: 'id', value: (row) => row.id },
    ],
    (row) => row.id,
    (row) => row.identifier,
  )
}

export function resourceIdentifierPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Resource>(
    'pick resource',
    () => ctx.client.resources.list(ctx.zoneId),
    [
      { header: 'identifier', width: 30, value: (row) => row.identifier },
      { header: 'name', width: 20, value: (row) => row.name ?? '-' },
      { header: 'scopes', value: (row) => (row.scopes ?? []).join(',') || '-' },
    ],
    (row) => row.identifier,
    (row) => row.identifier,
  )
}

function providerPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Provider>(
    'pick provider',
    () => ctx.client.providers.list(ctx.zoneId),
    [
      { header: 'identifier', width: 24, value: (row) => row.identifier },
      { header: 'kind', width: 10, value: (row) => row.kind ?? '-' },
      { header: 'id', value: (row) => row.id },
    ],
    (row) => row.id,
    (row) => row.identifier,
  )
}

function sessionPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Session>(
    'pick active session',
    () => ctx.client.sessions.list(ctx.zoneId, { status: 'active', limit: 100 }),
    [
      { header: 'subject', width: 30, value: (row) => row.subject_id },
      { header: 'type', width: 10, value: (row) => row.session_type },
      { header: 'id', value: (row) => row.id },
    ],
    (row) => row.id,
    (row) => row.subject_id,
  )
}

function delegationPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<DelegationEdge>(
    'pick delegation',
    async () => (await ctx.client.delegations.active(ctx.zoneId)).items,
    [
      { header: 'source', width: 28, value: (row) => row.source_session_id },
      { header: 'target', width: 28, value: (row) => row.target_session_id },
      { header: 'id', value: (row) => row.id },
    ],
    (row) => row.id,
    (row) => row.id,
  )
}

function policyVersionPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<PolicyVersion & { policy_name: string }>(
    'pick policy version',
    async () => {
      const policies = await ctx.client.policies.list(ctx.zoneId)
      const details = await Promise.all(policies.map((policy) => ctx.client.policies.get(ctx.zoneId, policy.id)))
      return details.flatMap((policy) => (policy.versions ?? []).map((version) => ({ ...version, policy_name: policy.name })))
    },
    [
      { header: 'policy', width: 24, value: (row) => row.policy_name },
      { header: 'version', width: 8, value: (row) => String(row.version) },
      { header: 'id', value: (row) => row.id },
    ],
    (row) => row.id,
    (row) => `${row.policy_name} v${row.version}`,
    appendCsv,
  )
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
    state: ctx.state,
    stateKey: 'zones',
    rowKey: (row) => row.id,
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
          ],
          onSubmit: async (v, app) => {
            await ctx.client.zones.create({
              name: v.name!,
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
              { key: 'dcr_enabled', label: 'dynamic clients', kind: 'bool', default: String(row.dcr_enabled) },
              { key: 'pkce_required', label: 'require PKCE', kind: 'bool', default: String(row.pkce_required) },
              { key: 'login_flow', label: 'login flow', kind: 'text', default: row.login_flow },
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
    state: ctx.state,
    stateKey: 'applications',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    onEnter: (app, row) => open(app, detail(`app / ${row.name}`, () => ctx.client.applications.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create application',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            { key: 'credential_type', label: 'credential', kind: 'select', options: CREDENTIAL_TYPES, default: 'public' },
            { key: 'consent', label: 'require consent', kind: 'bool', default: 'false' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.applications.create(ctx.zoneId, {
              name: v.name!,
              registration_method: 'managed',
              credential_type: (v.credential_type as CredentialType) || undefined,
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
              { key: 'credential_type', label: 'credential', kind: 'select', options: CREDENTIAL_TYPES, default: row.credential_type },
              { key: 'traits', label: 'traits', kind: 'list', default: (row.traits ?? []).join(','), hint: 'comma-separated' },
              { key: 'consent', label: 'require consent', kind: 'bool', default: String(row.consent === 'required') },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.applications.patch(ctx.zoneId, row.id, {
                name: v.name || undefined,
                credential_type: (v.credential_type as CredentialType) || undefined,
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
              { key: 'credential_type', label: 'credential', kind: 'select', options: CREDENTIAL_TYPES, default: row?.credential_type ?? 'public' },
              { key: 'traits', label: 'traits', kind: 'list', default: (row?.traits ?? []).join(','), hint: 'comma-separated' },
              { key: 'expires_in', label: 'expires in', kind: 'text', validate: (v) => v && !Number.isFinite(Number.parseInt(v, 10)) ? 'expires in must be an integer' : undefined },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.applications.dcr(ctx.zoneId, {
                name: v.name!,
                credential_type: (v.credential_type as ApplicationInput['credential_type']) || undefined,
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
    state: ctx.state,
    stateKey: 'resources',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    onEnter: (app, row) => open(app, detail(`resource / ${row.identifier}`, () => ctx.client.resources.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create resource',
          fields: [
            { key: 'identifier', label: 'identifier', kind: 'text', required: true },
            { key: 'scopes', label: 'scopes', kind: 'list', required: true, hint: 'comma-separated, e.g. read,write' },
            { key: 'name', label: 'name', kind: 'text' },
            { key: 'upstream_url', label: 'upstream URL', kind: 'text' },
            { key: 'gateway_application_id', label: 'gateway app', kind: 'text', pick: applicationPicker(ctx) },
            { key: 'prefix', label: 'prefix match', kind: 'bool', default: 'false' },
            { key: 'credential_provider_id', label: 'provider', kind: 'text', pick: providerPicker(ctx) },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.resources.create(ctx.zoneId, {
              identifier: v.identifier!,
              scopes: splitList(v.scopes ?? ''),
              name: v.name || undefined,
              upstream_url: v.upstream_url || undefined,
              gateway_application_id: v.gateway_application_id || undefined,
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
              { key: 'upstream_url', label: 'upstream URL', kind: 'text', default: row.upstream_url ?? '' },
              { key: 'gateway_application_id', label: 'gateway app', kind: 'text', default: row.gateway_application_id ?? '', pick: applicationPicker(ctx) },
              { key: 'credential_provider_id', label: 'provider', kind: 'text', default: row.credential_provider_id ?? '', pick: providerPicker(ctx) },
              { key: 'prefix', label: 'prefix match', kind: 'bool', default: String(row.prefix) },
              { key: 'scopes', label: 'scopes', kind: 'list', default: (row.scopes ?? []).join(','), hint: 'comma-separated' },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.resources.patch(ctx.zoneId, row.id, {
                name: v.name || undefined,
                identifier: v.identifier || undefined,
                upstream_url: v.upstream_url || undefined,
                gateway_application_id: v.gateway_application_id || undefined,
                credential_provider_id: v.credential_provider_id || undefined,
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
    state: ctx.state,
    stateKey: 'providers',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    onEnter: (app, row) => open(app, detail(`provider / ${row.identifier}`, () => ctx.client.providers.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create provider',
          fields: [
            { key: 'identifier', label: 'identifier', kind: 'text', required: true },
            { key: 'name', label: 'name', kind: 'text' },
            { key: 'kind', label: 'kind', kind: 'select', options: PROVIDER_KINDS, default: 'oauth2' },
            { key: 'client_id', label: 'client ID', kind: 'text' },
            { key: 'config_file', label: 'config file', kind: 'file' },
            { key: 'config_json', label: 'inline config', kind: 'multiline', hint: 'JSON object; secrets are sealed and hidden on read' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.providers.create(ctx.zoneId, {
              identifier: v.identifier!,
              name: v.name || undefined,
              kind: (v.kind as ProviderKind) || undefined,
              client_id: v.client_id || undefined,
              config_json: providerConfig(v.config_file ?? '', v.config_json ?? ''),
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
              { key: 'kind', label: 'kind', kind: 'select', options: PROVIDER_KINDS, default: row.kind ?? 'oauth2' },
              { key: 'client_id', label: 'client ID', kind: 'text', default: row.client_id ?? '' },
              { key: 'config_file', label: 'merge config file', kind: 'file' },
              { key: 'config_json', label: 'merge inline config', kind: 'multiline', hint: 'leave blank to keep existing config' },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.providers.patch(ctx.zoneId, row.id, {
                name: v.name || undefined,
                identifier: v.identifier || undefined,
                kind: (v.kind as ProviderKind) || undefined,
                client_id: v.client_id || undefined,
                config_json: providerConfig(v.config_file ?? '', v.config_json ?? ''),
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
    state: ctx.state,
    stateKey: 'policies',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    onEnter: (app, row) => open(app, detail(`policy / ${row.name}`, () => ctx.client.policies.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create policy',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            { key: 'description', label: 'description', kind: 'text' },
            { key: 'file', label: 'file', kind: 'file' },
            { key: 'content', label: 'content', kind: 'multiline' },
          ],
          onSubmit: async (v, app) => {
            const content = readFileOrInline(v.file ?? '', v.content ?? '')
            if (!content) throw new Error('file or content required')
            await ctx.client.policies.create(ctx.zoneId, {
              name: v.name!,
              description: v.description || undefined,
              content,
            })
            await popAndReload(app, list as unknown as ListView<unknown>)
          },
        }),
      },
      {
        key: 'c', label: 'validate', build: () => new FormView({
          title: 'validate policy',
          fields: [
            { key: 'file', label: 'file', kind: 'file' },
            { key: 'content', label: 'content', kind: 'multiline' },
          ],
          onSubmit: async (v, app) => {
            const content = readFileOrInline(v.file ?? '', v.content ?? '')
            if (!content) throw new Error('file or content required')
            const result = await ctx.client.policies.validate(content)
            app.pop()
            app.push(detail('policy validate', async () => result))
          },
        }),
      },
      {
        key: 'v', label: 'version', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `version ${row.name}`,
            fields: [
              { key: 'file', label: 'file', kind: 'file' },
              { key: 'content', label: 'content', kind: 'multiline' },
            ],
            onSubmit: async (v, app) => {
              const content = readFileOrInline(v.file ?? '', v.content ?? '')
              if (!content) throw new Error('file or content required')
              await ctx.client.policies.addVersion(ctx.zoneId, row.id, content)
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
    state: ctx.state,
    stateKey: 'policy-sets',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
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
              { key: 'policy_versions', label: 'policy versions', kind: 'list', required: true, pick: policyVersionPicker(ctx), hint: 'right arrow adds versions' },
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
              { key: 'version_id', label: 'version', kind: 'text', required: true },
              { key: 'shadow_version_id', label: 'shadow version', kind: 'text' },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.policySets.activate(ctx.zoneId, row.id, v.version_id!, v.shadow_version_id || undefined)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 's', label: 'simulate', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new FormView({
            title: `simulate ${row.name}`,
            fields: [
              { key: 'version_id', label: 'version', kind: 'text', required: true, default: row.active_version_id ?? '' },
              { key: 'input_file', label: 'input file', kind: 'file' },
              { key: 'input', label: 'inline input', kind: 'multiline', hint: 'JSON object; leave blank for rollout-only simulation' },
            ],
            onSubmit: async (v, app) => {
              const inputValue = readFileOrInline(v.input_file ?? '', v.input ?? '')
              const result = await ctx.client.policySets.simulate(
                ctx.zoneId,
                row.id,
                v.version_id!,
                inputValue ? parseJsonObject(inputValue) : undefined,
              )
              app.pop()
              app.push(detail(`policy-set simulate / ${row.name}`, async () => result))
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
    state: ctx.state,
    stateKey: 'grants',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    onEnter: (app, row) => open(app, detail(`grant / ${row.id}`, () => ctx.client.grants.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create grant',
          fields: [
            { key: 'application_id', label: 'application', kind: 'text', required: true, pick: applicationPicker(ctx) },
            { key: 'user_id', label: 'subject', kind: 'text', required: true },
            { key: 'resource_id', label: 'resource', kind: 'text', required: true, pick: resourcePicker(ctx) },
            { key: 'scopes', label: 'scopes', kind: 'list', required: true, hint: 'comma-separated subset of resource scopes' },
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
  const filters: SessionQuery = { ...ctx.state?.sessionFilters(ctx.zoneId) }
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
    state: ctx.state,
    stateKey: 'sessions',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
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
              ctx.state?.setSessionFilters(ctx.zoneId, filters)
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
    { key: 'a', label: 'active', build: () => delegationActiveView(this.ctx) },
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
      fields: [{ key: 'session_id', label: 'session', kind: 'text', required: true, pick: sessionPicker(this.ctx) }],
      onSubmit: async (v, app) => {
        app.pop()
        app.push(delegationEdgesView(this.ctx, kind, v.session_id!))
      },
    })
  }

  private traverseForm(): View {
    return new FormView({
      title: 'delegation traverse',
      fields: [{ key: 'edge_id', label: 'delegation', kind: 'text', required: true, pick: delegationPicker(this.ctx) }],
      onSubmit: async (v, app) => {
        app.pop()
        app.push(delegationTraverseView(this.ctx, v.edge_id!))
      },
    })
  }

  private revokeForm(): View {
    return new FormView({
      title: 'delegation revoke',
      fields: [{ key: 'edge_id', label: 'delegation', kind: 'text', required: true, pick: delegationPicker(this.ctx) }],
      onSubmit: async (v, app) => {
        const result = await this.ctx.client.delegations.revoke(this.ctx.zoneId, v.edge_id!)
        app.pop()
        app.push(detail(`delegation / ${v.edge_id}`, async () => result))
      },
    })
  }
}

function delegationActiveView(ctx: Ctx): ListView<DelegationEdge> {
  return new ListView<DelegationEdge>({
    title: 'delegations / active',
    columns: [
      { header: 'source', width: 36, value: (r) => r.source_session_id },
      { header: 'target', width: 36, value: (r) => r.target_session_id },
      { header: 'resource', width: 24, value: (r) => r.resource_id ?? '-' },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'id', value: (r) => r.id },
    ],
    load: async () => (await ctx.client.delegations.active(ctx.zoneId)).items,
    state: ctx.state,
    stateKey: 'delegations-active',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    onEnter: (app, row) => open(app, detail(`delegation / ${row.id}`, async () => row)),
  })
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
    state: ctx.state,
    stateKey: `delegations-${kind}-${sessionId}`,
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
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
    state: ctx.state,
    stateKey: `delegation-traverse-${id}`,
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
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
      { header: 'id', value: (r) => r.agent_session_id },
    ],
    load: () => ctx.client.agents.list(ctx.zoneId),
    state: ctx.state,
    stateKey: 'agents',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.agent_session_id,
    onEnter: (app, row) => open(app, detail(`agent / ${row.agent_session_id}`, () => ctx.client.agents.get(ctx.zoneId, row.agent_session_id))),
    actions: [
      {
        key: 's', label: 'suspend', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `suspend agent ${row.agent_session_id}?`,
            onConfirm: async (app) => {
              await ctx.client.agents.suspend(ctx.zoneId, row.agent_session_id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'r', label: 'resume', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `resume agent ${row.agent_session_id}?`,
            onConfirm: async (app) => {
              await ctx.client.agents.resume(ctx.zoneId, row.agent_session_id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 't', label: 'terminate', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `terminate agent ${row.agent_session_id}?`,
            onConfirm: async (app) => {
              await ctx.client.agents.terminate(ctx.zoneId, row.agent_session_id)
              await popAndReload(app, list as unknown as ListView<unknown>)
            },
          })
        },
      },
      {
        key: 'T', label: 'tree', build: (row) => {
          if (!row) throw new Error('no row selected')
          return detail(`agent-tree / ${row.agent_session_id}`, () => ctx.client.agents.children(ctx.zoneId, row.agent_session_id))
        },
      },
    ],
  })
  return list
}

export function auditView(ctx: Ctx): View {
  const filters: AuditQuery = { ...ctx.state?.auditFilters(ctx.zoneId) }
  return new FormView({
    title: 'audit filters',
    submitLabel: 'tail',
    fields: [
      { key: 'decision', label: 'decision', kind: 'select', options: ['', 'allow', 'deny', 'partial'], default: filters.decision ?? '' },
      { key: 'since', label: 'since', kind: 'text', default: filters.since ?? '' },
      { key: 'until', label: 'until', kind: 'text', default: filters.until ?? '' },
      { key: 'request_id', label: 'request ID', kind: 'text', default: filters.request_id ?? '' },
      { key: 'event_type', label: 'event type', kind: 'text', default: filters.event_type ?? '' },
      { key: 'limit', label: 'limit', kind: 'text', default: filters.limit === undefined ? '100' : String(filters.limit), validate: (v) => v ? (Number.isFinite(Number.parseInt(v, 10)) ? undefined : 'limit must be an integer') : undefined },
    ],
    onSubmit: async (v, app) => {
      filters.decision = (v.decision as AuditQuery['decision']) || undefined
      filters.since = v.since || undefined
      filters.until = v.until || undefined
      filters.request_id = v.request_id || undefined
      filters.event_type = v.event_type || undefined
      filters.limit = int(v.limit)
      ctx.state?.setAuditFilters(ctx.zoneId, filters)
      app.pop()
      app.push(new AuditTailView(ctx.client, ctx.zoneId, filters, (next) => ctx.state?.setAuditFilters(ctx.zoneId, next)))
    },
  })
}
