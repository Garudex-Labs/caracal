// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// View factories: list + detail views with full create/edit/delete actions.

import type {
  AdminClient,
  AgentSession,
  Application,
  CredentialType,
  Grant,
  Policy,
  PolicySet,
  Provider,
  ProviderKind,
  RegistrationMethod,
  Resource,
  Session,
  Zone,
} from '@caracalai/admin'
import type { View } from '../screen.ts'
import type { FieldDef } from './form.ts'
import { ConfirmView, FormView } from './form.ts'
import { AuditTailView } from './audit.ts'
import { DetailView } from './detail.ts'
import { ListView } from './list.ts'

export interface Ctx {
  client: AdminClient
  zoneId: string
  onZoneSelect?: (id: string, slug: string) => void
}

export function detailViewFor(title: string, load: () => Promise<unknown>): DetailView {
  return new DetailView({ title, load })
}

// ── Zones ────────────────────────────────────────────────────────────────────

const zoneFields: FieldDef[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'slug', label: 'Slug', hint: 'URL-safe, auto-derived from name if blank' },
  { key: 'org_id', label: 'Org ID' },
  { key: 'dcr_enabled', label: 'DCR', hint: 'true / false' },
  { key: 'pkce_required', label: 'PKCE', hint: 'true / false' },
  { key: 'login_flow', label: 'Login flow', hint: 'e.g. standard' },
]

function parseBool(v: string | undefined): boolean | undefined {
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

export function zonesView(ctx: Ctx): View {
  return new ListView<Zone>({
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
      app.push(detailViewFor(`zone / ${row.slug}`, () => ctx.client.zones.get(row.id)))
    },
    extraHints: ['c:create', 'e:edit', 'D:delete'],
    onKey: (app, key, row, view) => {
      if (key === 'c') {
        app.push(new FormView('create zone', zoneFields, async (v, a) => {
          const zone = await ctx.client.zones.create({
            name: v.name!,
            slug: v.slug || undefined,
            org_id: v.org_id || undefined,
            dcr_enabled: parseBool(v.dcr_enabled),
            pkce_required: parseBool(v.pkce_required),
            login_flow: v.login_flow || undefined,
          })
          await view.reload(a)
          a.setStatus(`created zone ${zone.slug} (${zone.id})`)
        }))
        return
      }
      if (key === 'e' && row) {
        app.push(new FormView('edit zone', zoneFields, async (v, a) => {
          await ctx.client.zones.patch(row.id, {
            name: v.name || undefined,
            slug: v.slug || undefined,
            org_id: v.org_id || undefined,
            dcr_enabled: v.dcr_enabled ? parseBool(v.dcr_enabled) : undefined,
            pkce_required: v.pkce_required ? parseBool(v.pkce_required) : undefined,
            login_flow: v.login_flow || undefined,
          })
          await view.reload(a)
          a.setStatus(`updated zone ${row.slug}`)
        }, {
          name: row.name,
          slug: row.slug,
          dcr_enabled: String(row.dcr_enabled),
          pkce_required: String(row.pkce_required),
          login_flow: row.login_flow,
        }))
        return
      }
      if (key === 'D' && row) {
        app.push(new ConfirmView(
          'delete zone',
          `Delete zone "${row.slug}" (${row.id})? All resources will be removed.`,
          async (a) => {
            await ctx.client.zones.delete(row.id)
            await view.reload(a)
            a.setStatus(`deleted zone ${row.slug}`)
          },
        ))
      }
    },
  })
}

// ── Applications ─────────────────────────────────────────────────────────────

const appCreateFields: FieldDef[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'registration_method', label: 'Method', hint: 'managed (default) or dcr' },
  { key: 'credential_type', label: 'Credential', hint: 'token | password | public-key | url | public' },
  { key: 'client_secret', label: 'Secret' },
  { key: 'traits', label: 'Traits', hint: 'comma-separated' },
  { key: 'consent', label: 'Consent', hint: 'true / false' },
]

const appEditFields: FieldDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'credential_type', label: 'Credential', hint: 'token | password | public-key | url | public' },
  { key: 'client_secret', label: 'Secret' },
  { key: 'traits', label: 'Traits', hint: 'comma-separated' },
  { key: 'consent', label: 'Consent', hint: 'true / false' },
]

export function applicationsView(ctx: Ctx): View {
  return new ListView<Application>({
    title: 'applications',
    columns: [
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'method', width: 8, value: (r) => r.registration_method },
      { header: 'cred', width: 12, value: (r) => r.credential_type },
      { header: 'traits', width: 24, value: (r) => (r.traits ?? []).join(',') || '-' },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.applications.list(ctx.zoneId),
    onEnter: (app, row) => app.push(detailViewFor(`app / ${row.name}`, () => ctx.client.applications.get(ctx.zoneId, row.id))),
    extraHints: ['c:create', 'e:edit', 'D:delete'],
    onKey: (app, key, row, view) => {
      if (key === 'c') {
        app.push(new FormView('create application', appCreateFields, async (v, a) => {
          const app_ = await ctx.client.applications.create(ctx.zoneId, {
            name: v.name!,
            registration_method: (v.registration_method as RegistrationMethod) || 'managed',
            credential_type: (v.credential_type as CredentialType) || undefined,
            client_secret: v.client_secret || undefined,
            traits: v.traits ? v.traits.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
            consent: v.consent ? parseBool(v.consent) : undefined,
          })
          await view.reload(a)
          a.setStatus(`created app ${app_.name} (${app_.id})`)
        }))
        return
      }
      if (key === 'e' && row) {
        app.push(new FormView('edit application', appEditFields, async (v, a) => {
          await ctx.client.applications.patch(ctx.zoneId, row.id, {
            name: v.name || undefined,
            credential_type: (v.credential_type as CredentialType) || undefined,
            client_secret: v.client_secret || undefined,
            traits: v.traits ? v.traits.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
            consent: v.consent ? parseBool(v.consent) : undefined,
          })
          await view.reload(a)
          a.setStatus(`updated app ${row.name}`)
        }, {
          name: row.name,
          credential_type: row.credential_type,
          traits: (row.traits ?? []).join(','),
          consent: String(row.consent),
        }))
        return
      }
      if (key === 'D' && row) {
        app.push(new ConfirmView(
          'delete application',
          `Delete application "${row.name}" (${row.id})?`,
          async (a) => {
            await ctx.client.applications.delete(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`deleted app ${row.name}`)
          },
        ))
      }
    },
  })
}

// ── Resources ─────────────────────────────────────────────────────────────────

const resourceCreateFields: FieldDef[] = [
  { key: 'identifier', label: 'Identifier', required: true },
  { key: 'scopes', label: 'Scopes', required: true, hint: 'comma-separated' },
  { key: 'name', label: 'Name' },
  { key: 'upstream_url', label: 'Upstream URL' },
  { key: 'prefix', label: 'Prefix', hint: 'true / false' },
  { key: 'credential_provider_id', label: 'Provider ID' },
]

const resourceEditFields: FieldDef[] = [
  { key: 'identifier', label: 'Identifier' },
  { key: 'name', label: 'Name' },
  { key: 'upstream_url', label: 'Upstream URL' },
  { key: 'scopes', label: 'Scopes', hint: 'comma-separated' },
  { key: 'prefix', label: 'Prefix', hint: 'true / false' },
  { key: 'credential_provider_id', label: 'Provider ID' },
]

export function resourcesView(ctx: Ctx): View {
  return new ListView<Resource>({
    title: 'resources',
    columns: [
      { header: 'identifier', width: 32, value: (r) => r.identifier },
      { header: 'name', width: 18, value: (r) => r.name ?? '-' },
      { header: 'upstream', width: 32, value: (r) => r.upstream_url ?? '-' },
      { header: 'scopes', value: (r) => (r.scopes ?? []).join(' ') || '-' },
    ],
    load: () => ctx.client.resources.list(ctx.zoneId),
    onEnter: (app, row) => app.push(detailViewFor(`resource / ${row.identifier}`, () => ctx.client.resources.get(ctx.zoneId, row.id))),
    extraHints: ['c:create', 'e:edit', 'D:delete'],
    onKey: (app, key, row, view) => {
      if (key === 'c') {
        app.push(new FormView('create resource', resourceCreateFields, async (v, a) => {
          const res = await ctx.client.resources.create(ctx.zoneId, {
            identifier: v.identifier!,
            scopes: v.scopes!.split(',').map((s) => s.trim()).filter(Boolean),
            name: v.name || undefined,
            upstream_url: v.upstream_url || undefined,
            prefix: v.prefix ? parseBool(v.prefix) : undefined,
            credential_provider_id: v.credential_provider_id || undefined,
          })
          await view.reload(a)
          a.setStatus(`created resource ${res.identifier}`)
        }))
        return
      }
      if (key === 'e' && row) {
        app.push(new FormView('edit resource', resourceEditFields, async (v, a) => {
          await ctx.client.resources.patch(ctx.zoneId, row.id, {
            identifier: v.identifier || undefined,
            name: v.name || undefined,
            upstream_url: v.upstream_url || undefined,
            scopes: v.scopes ? v.scopes.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
            prefix: v.prefix ? parseBool(v.prefix) : undefined,
            credential_provider_id: v.credential_provider_id || undefined,
          })
          await view.reload(a)
          a.setStatus(`updated resource ${row.identifier}`)
        }, {
          identifier: row.identifier,
          name: row.name ?? '',
          upstream_url: row.upstream_url ?? '',
          scopes: (row.scopes ?? []).join(','),
          prefix: String(row.prefix),
          credential_provider_id: row.credential_provider_id ?? '',
        }))
        return
      }
      if (key === 'D' && row) {
        app.push(new ConfirmView(
          'delete resource',
          `Delete resource "${row.identifier}" (${row.id})?`,
          async (a) => {
            await ctx.client.resources.delete(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`deleted resource ${row.identifier}`)
          },
        ))
      }
    },
  })
}

// ── Providers ─────────────────────────────────────────────────────────────────

const providerCreateFields: FieldDef[] = [
  { key: 'identifier', label: 'Identifier', required: true },
  { key: 'name', label: 'Name' },
  { key: 'kind', label: 'Kind', hint: 'oauth2 | oidc | apikey | workload' },
  { key: 'owner_type', label: 'Owner type' },
  { key: 'client_id', label: 'Client ID' },
  { key: 'config_json', label: 'Config JSON', hint: 'inline JSON object' },
]

export function providersView(ctx: Ctx): View {
  return new ListView<Provider>({
    title: 'providers',
    columns: [
      { header: 'identifier', width: 24, value: (r) => r.identifier },
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'kind', width: 10, value: (r) => r.kind ?? '-' },
      { header: 'owner', width: 10, value: (r) => r.owner_type },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.providers.list(ctx.zoneId),
    onEnter: (app, row) => app.push(detailViewFor(`provider / ${row.identifier}`, () => ctx.client.providers.get(ctx.zoneId, row.id))),
    extraHints: ['c:create', 'e:edit', 'D:delete'],
    onKey: (app, key, row, view) => {
      if (key === 'c') {
        app.push(new FormView('create provider', providerCreateFields, async (v, a) => {
          const prov = await ctx.client.providers.create(ctx.zoneId, {
            identifier: v.identifier!,
            name: v.name || undefined,
            kind: (v.kind as ProviderKind) || undefined,
            owner_type: v.owner_type || undefined,
            client_id: v.client_id || undefined,
            config_json: v.config_json ? JSON.parse(v.config_json) as Record<string, unknown> : undefined,
          })
          await view.reload(a)
          a.setStatus(`created provider ${prov.identifier}`)
        }))
        return
      }
      if (key === 'e' && row) {
        app.push(new FormView('edit provider', providerCreateFields, async (v, a) => {
          await ctx.client.providers.patch(ctx.zoneId, row.id, {
            identifier: v.identifier || undefined,
            name: v.name || undefined,
            kind: (v.kind as ProviderKind) || undefined,
            owner_type: v.owner_type || undefined,
            client_id: v.client_id || undefined,
            config_json: v.config_json ? JSON.parse(v.config_json) as Record<string, unknown> : undefined,
          })
          await view.reload(a)
          a.setStatus(`updated provider ${row.identifier}`)
        }, {
          identifier: row.identifier,
          name: row.name,
          kind: row.kind ?? '',
          owner_type: row.owner_type,
          client_id: row.client_id ?? '',
          config_json: row.config_json ? JSON.stringify(row.config_json) : '',
        }))
        return
      }
      if (key === 'D' && row) {
        app.push(new ConfirmView(
          'delete provider',
          `Delete provider "${row.identifier}" (${row.id})?`,
          async (a) => {
            await ctx.client.providers.delete(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`deleted provider ${row.identifier}`)
          },
        ))
      }
    },
  })
}

// ── Policies ──────────────────────────────────────────────────────────────────

const policyCreateFields: FieldDef[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'content', label: 'Rego', required: true, hint: 'policy content (single-line or paste)' },
  { key: 'description', label: 'Description' },
  { key: 'owner_type', label: 'Owner type' },
]

export function policiesView(ctx: Ctx): View {
  return new ListView<Policy>({
    title: 'policies',
    columns: [
      { header: 'name', width: 28, value: (r) => r.name },
      { header: 'owner', width: 10, value: (r) => r.owner_type },
      { header: 'description', width: 32, value: (r) => r.description ?? '-' },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.policies.list(ctx.zoneId),
    onEnter: (app, row) => app.push(detailViewFor(`policy / ${row.name}`, () => ctx.client.policies.get(ctx.zoneId, row.id))),
    extraHints: ['c:create', 'D:archive'],
    onKey: (app, key, row, view) => {
      if (key === 'c') {
        app.push(new FormView('create policy', policyCreateFields, async (v, a) => {
          const pol = await ctx.client.policies.create(ctx.zoneId, {
            name: v.name!,
            content: v.content!,
            description: v.description || undefined,
            owner_type: v.owner_type || undefined,
          })
          await view.reload(a)
          a.setStatus(`created policy ${pol.name} (${pol.id})`)
        }))
        return
      }
      if (key === 'D' && row) {
        app.push(new ConfirmView(
          'archive policy',
          `Archive policy "${row.name}" (${row.id})?`,
          async (a) => {
            await ctx.client.policies.delete(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`archived policy ${row.name}`)
          },
        ))
      }
    },
  })
}

// ── Policy sets ───────────────────────────────────────────────────────────────

const policySetCreateFields: FieldDef[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'description', label: 'Description' },
]

const activateFields: FieldDef[] = [
  { key: 'version_id', label: 'Version ID', required: true, hint: 'policy-set version UUID to activate' },
  { key: 'shadow_version_id', label: 'Shadow ID', hint: 'optional shadow version UUID' },
]

export function policySetsView(ctx: Ctx): View {
  return new ListView<PolicySet>({
    title: 'policy-sets',
    columns: [
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'active_version', width: 36, value: (r) => r.active_version_id ?? '(none)' },
      { header: 'description', value: (r) => r.description ?? '-' },
    ],
    load: () => ctx.client.policySets.list(ctx.zoneId),
    onEnter: (app, row) => app.push(detailViewFor(`policy-set / ${row.name}`, () => ctx.client.policySets.get(ctx.zoneId, row.id))),
    extraHints: ['c:create', 'a:activate', 'D:archive'],
    onKey: (app, key, row, view) => {
      if (key === 'c') {
        app.push(new FormView('create policy-set', policySetCreateFields, async (v, a) => {
          const ps = await ctx.client.policySets.create(ctx.zoneId, v.name!, v.description || undefined)
          await view.reload(a)
          a.setStatus(`created policy-set ${ps.name} (${ps.id})`)
        }))
        return
      }
      if (key === 'a' && row) {
        app.push(new FormView('activate policy-set', activateFields, async (v, a) => {
          const result = await ctx.client.policySets.activate(
            ctx.zoneId, row.id, v.version_id!, v.shadow_version_id || undefined,
          )
          await view.reload(a)
          a.setStatus(`activated policy-set ${row.name} → version ${result.version_id}`)
        }, { version_id: row.active_version_id ?? '' }))
        return
      }
      if (key === 'D' && row) {
        app.push(new ConfirmView(
          'archive policy-set',
          `Archive policy-set "${row.name}" (${row.id})?`,
          async (a) => {
            await ctx.client.policySets.delete(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`archived policy-set ${row.name}`)
          },
        ))
      }
    },
  })
}

// ── Grants ────────────────────────────────────────────────────────────────────

const grantCreateFields: FieldDef[] = [
  { key: 'application_id', label: 'App ID', required: true },
  { key: 'user_id', label: 'User ID', required: true },
  { key: 'resource_id', label: 'Resource ID', required: true },
  { key: 'scopes', label: 'Scopes', required: true, hint: 'comma-separated' },
]

export function grantsView(ctx: Ctx): View {
  return new ListView<Grant>({
    title: 'grants',
    columns: [
      { header: 'app', width: 36, value: (r) => r.application_id },
      { header: 'user', width: 36, value: (r) => r.user_id },
      { header: 'resource', width: 36, value: (r) => r.resource_id },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'scopes', value: (r) => (r.scopes ?? []).join(' ') || '-' },
    ],
    load: () => ctx.client.grants.list(ctx.zoneId),
    onEnter: (app, row) => app.push(detailViewFor(`grant / ${row.id}`, () => ctx.client.grants.get(ctx.zoneId, row.id))),
    extraHints: ['c:create', 'D:revoke'],
    onKey: (app, key, row, view) => {
      if (key === 'c') {
        app.push(new FormView('create grant', grantCreateFields, async (v, a) => {
          const g = await ctx.client.grants.create(ctx.zoneId, {
            application_id: v.application_id!,
            user_id: v.user_id!,
            resource_id: v.resource_id!,
            scopes: v.scopes!.split(',').map((s) => s.trim()).filter(Boolean),
          })
          await view.reload(a)
          a.setStatus(`created grant ${g.id}`)
        }))
        return
      }
      if (key === 'D' && row) {
        app.push(new ConfirmView(
          'revoke grant',
          `Revoke grant ${row.id} (app ${row.application_id}, user ${row.user_id})?`,
          async (a) => {
            await ctx.client.grants.revoke(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`revoked grant ${row.id}`)
          },
        ))
      }
    },
  })
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export function sessionsView(ctx: Ctx): View {
  return new ListView<Session>({
    title: 'sessions',
    columns: [
      { header: 'subject', width: 36, value: (r) => r.subject_id },
      { header: 'type', width: 10, value: (r) => r.session_type },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'expires_at', width: 24, value: (r) => r.expires_at },
      { header: 'id', value: (r) => r.id },
    ],
    load: () => ctx.client.sessions.list(ctx.zoneId),
  })
}

// ── Agents ────────────────────────────────────────────────────────────────────

export function agentsView(ctx: Ctx): View {
  return new ListView<AgentSession>({
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
    onEnter: (app, row) => app.push(detailViewFor(`agent / ${row.id}`, () => ctx.client.agents.get(ctx.zoneId, row.id))),
    extraHints: ['s:suspend', 'u:resume', 'D:terminate'],
    onKey: (app, key, row, view) => {
      if (key === 's' && row) {
        app.push(new ConfirmView(
          'suspend agent',
          `Suspend agent ${row.id}?`,
          async (a) => {
            await ctx.client.agents.suspend(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`suspended agent ${row.id}`)
          },
        ))
        return
      }
      if (key === 'u' && row) {
        app.push(new ConfirmView(
          'resume agent',
          `Resume agent ${row.id}?`,
          async (a) => {
            await ctx.client.agents.resume(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`resumed agent ${row.id}`)
          },
        ))
        return
      }
      if (key === 'D' && row) {
        app.push(new ConfirmView(
          'terminate agent',
          `Terminate agent ${row.id}? The agent session will be ended.`,
          async (a) => {
            await ctx.client.agents.terminate(ctx.zoneId, row.id)
            await view.reload(a)
            a.setStatus(`terminated agent ${row.id}`)
          },
        ))
      }
    },
  })
}

// ── Audit tail ────────────────────────────────────────────────────────────────

export function auditView(ctx: Ctx): View {
  return new AuditTailView(ctx.client, ctx.zoneId)
}
