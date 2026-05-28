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
  PolicyVersion,
  PolicySet,
  PolicySetVersion,
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
import type { ConsoleStateStore } from '../state.ts'
import { maskSecretField } from '../errors.ts'
import { formatDateTimeOrValue } from '../format.ts'
import { DEFAULT_CONTROL_AUDIENCE } from '@caracalai/engine'
import { AuditTailView } from './audit.ts'
import { DetailView } from './detail.ts'
import { ConfirmView, FormView, type Field } from './form.ts'
import { infoPage, openInfo, type InfoPage } from './info.ts'
import { ListView } from './list.ts'
import { appendCsv, EntityPickerView, pickFromList } from './picker.ts'

export interface Ctx {
  client: AdminClient
  zoneId: string
  onZoneSelect?: (id: string, slug: string) => void
  state?: ConsoleStateStore | undefined
}

function controlAudience(): string {
  return process.env.CONTROL_AUDIENCE ?? DEFAULT_CONTROL_AUDIENCE
}

function userResources(resources: Resource[]): Resource[] {
  const audience = controlAudience()
  return resources.filter((resource) => resource.identifier !== audience)
}

function detail(title: string, load: () => Promise<unknown>, copyPage = true): DetailView {
  return new DetailView({ title, load, mask: maskSecretField, copyPage })
}

function entityDetail(title: string, load: () => Promise<unknown>): DetailView {
  return new DetailView({ title, load, mask: maskSecretField, copyPage: true, info: resourceDetailInfo(title) })
}

function applicationDetail(title: string, load: () => Promise<unknown>): DetailView {
  return new DetailView({
    title,
    load,
    mask: maskSecretField,
    copyPage: true,
    info: resourceDetailInfo(title),
    hide: (_value, path) => path.length === 1 && APPLICATION_INTERNAL_DETAIL_FIELDS.has(path[0] ?? ''),
  })
}

const APPLICATION_INTERNAL_DETAIL_FIELDS = new Set(['consent', 'credential_type', 'traits'])

function open(app: App, view: View): void { app.push(view) }

function splitList(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0)
}

function slugValue(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

function resourceIdentifierFromName(name: string): string {
  const text = name.trim()
  return text.startsWith('resource://') ? text : `resource://${slugValue(text)}`
}

function providerIdentifierFromValues(values: Record<string, string>): string {
  const explicit = values.identifier?.trim()
  if (explicit) return explicit
  const base = values.name?.trim() || `${providerKind(values.kind)} provider`
  return slugValue(base)
}

function inferredTokenHosts(endpoint: string | undefined): string {
  const value = endpoint?.trim()
  if (!value) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.hostname : ''
  } catch {
    return ''
  }
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined
  return v === 'true'
}

const APPLICATION_REGISTRATION_METHODS = ['managed', 'dcr'] as const
const PROVIDER_KINDS: ProviderKind[] = ['oauth2', 'oidc', 'apikey', 'workload']
const RESOURCE_MODES = ['direct', 'gateway'] as const
const CONTENT_SOURCES = ['paste', 'file'] as const

type PolicyVersionRow = PolicyVersion & { policy_name: string }
type PolicySetVersionRow = PolicySetVersion & { policy_set_name: string }
type PolicySetRow = PolicySet & { active_version_label: string }
type GrantRow = Grant & { application_name: string; resource_name: string }
type AgentRow = AgentSession & { application_name: string }
type DelegationRow = DelegationEdge & { resource_name?: string | undefined }

type ResourceHelpKind = 'zone' | 'application' | 'resource' | 'provider' | 'policy' | 'policy set' | 'grant' | 'session' | 'delegation' | 'agent'

function readFileOrInline(filePath: string, inline: string): string {
  if (filePath && filePath.length > 0) return readFileSync(filePath, 'utf8')
  return inline
}

function readPolicyContent(values: Record<string, string>): string {
  const source = values.source || (values.file ? 'file' : 'paste')
  return source === 'file'
    ? readFileOrInline(values.file ?? '', '')
    : values.content ?? ''
}

function resourceListInfo(kind: ResourceHelpKind): InfoPage {
  const help = resourceHelp(kind)
  return infoPage({
    title: `${help.title} list`,
    meaning: help.meaning,
    when: help.when,
    impact: help.impact,
    example: help.example,
    valid: 'Rows are loaded from the Control API for the current scope; use reload when another operator or automation may have changed state.',
    after: 'Press enter to open the full resource detail page; mutation keys only appear when the selected row supports them.',
    terms: help.terms,
    notes: help.notes,
  })
}

function resourceDetailInfo(title: string): InfoPage {
  const kind = resourceKindFromTitle(title)
  const help = resourceHelp(kind)
  return infoPage({
    title,
    meaning: `This page shows the raw ${help.title.toLowerCase()} object returned by the API, rendered for terminal reading.`,
    when: `Use it when you need to inspect one ${help.title.toLowerCase()}, confirm operational state, or copy the complete JSON record.`,
    impact: help.impact,
    example: help.example,
    valid: 'Values come from the backend response. Displayed timestamps and booleans may be formatted for reading, but copy-page preserves the raw JSON object.',
    after: 'Use copy-page for automation/debugging, reload to fetch the latest API state, or esc to return to the list.',
    terms: help.terms,
    notes: ['copy-page copies the complete loaded object, not the rendered labels or table values.', ...(help.notes ?? [])],
  })
}

function resourceKindFromTitle(title: string): ResourceHelpKind {
  const head = title.split('/')[0]?.trim().toLowerCase() ?? ''
  if (head === 'app') return 'application'
  if (head === 'policy set') return 'policy set'
  if (head === 'delegation-node') return 'delegation'
  if (head === 'zone' || head === 'resource' || head === 'provider' || head === 'policy' || head === 'grant' || head === 'delegation' || head === 'agent') return head
  return 'resource'
}

function resourceHelp(kind: ResourceHelpKind): InfoPage & { notes: string[] } {
  switch (kind) {
    case 'zone':
      return {
        title: 'Zone',
        meaning: 'A zone is the operational trust boundary for applications, resources, policies, grants, sessions, audit events, and agents.',
        when: 'Use zones to separate environments, tenants, or security domains that should not share authority.',
        impact: 'Selecting a zone scopes almost every management action; DCR on a zone controls whether apps can self-register through the DCR endpoint.',
        example: 'Pied Piper Production',
        valid: 'A zone has a name, slug, dynamic-client setting, and system metadata.',
        after: 'Open a zone to inspect its API object or select it as the active Console scope.',
        terms: [
          { label: 'Trust boundary', value: 'A separation line where authority, audit, and policy state are isolated.' },
          { label: 'DCR', value: 'Dynamic Client Registration; allows API-driven application registration only when enabled.' },
        ],
        notes: ['Keep production and non-production authority in separate zones.', 'Name zones after the boundary, not one service.'],
      }
    case 'application':
      return {
        title: 'Application',
        meaning: 'An application is a client identity that requests Caracal tokens for a workload, agent, gateway, or automation actor.',
        when: 'Use managed applications for known durable software and DCR applications for dynamic or self-registering clients.',
        impact: 'The registration method decides which creation path is used. DCR is gated by the selected zone, rate-limited, capped, and may expire; managed applications are operator-provisioned and stable.',
        example: 'Son of Anton, Fiona, PiperNet AI',
        valid: 'Console creates applications with a one-time client secret immediately after creation.',
        after: 'Open the detail page to inspect IDs, registration method, DCR expiry, and the exact API object through copy-page.',
        terms: [
          { label: 'Managed', value: 'Operator-provisioned identity for known long-lived agents, services, workers, gateways, CI jobs, and integrations.' },
          { label: 'DCR', value: 'Dynamic Client Registration for self-service, high-churn, or ephemeral clients when dynamic clients are enabled on the zone.' },
          { label: 'Client secret', value: 'One-time credential used by token applications; store it when Console displays it because it is not returned again.' },
        ],
        notes: ['One-time client secrets are shown only when created or rotated.', 'Use copy-page on details when debugging SDK or API calls.'],
      }
    case 'resource':
      return {
        title: 'Resource',
        meaning: 'A resource is a protected API, service, audience, or Gateway route that applications request access to.',
        when: 'Use resources to define what can be accessed and which Caracal scopes exist for that target.',
        impact: 'Resource identifiers and scopes become the vocabulary used by grants, policies, tokens, and Gateway bindings.',
        example: 'resource://pipernet',
        valid: 'Gateway resources include upstream routing fields; direct resources define an audience and scopes only.',
        after: 'Open details to inspect routing, scopes, provider binding, and raw API identifiers.',
        terms: [
          { label: 'Scope', value: 'A named permission on a resource, such as read, write, or admin.' },
          { label: 'Gateway', value: 'The proxy path where Caracal can enforce policy and forward requests upstream.' },
        ],
        notes: ['Changing identifiers can break clients that request the old audience.', 'Gateway fields only matter for resources configured with an upstream route.'],
      }
    case 'provider':
      return {
        title: 'Provider',
        meaning: 'A provider describes an upstream identity or credential source Caracal can use when calling protected services.',
        when: 'Use providers when Gateway or credential workflows must exchange, attach, or derive upstream credentials.',
        impact: 'Provider kind and config decide which endpoints, headers, audiences, and credential rules are used at runtime.',
        example: 'Hooli OIDC',
        valid: 'Only configured provider kinds and their implemented fields are sent to the API.',
        after: 'Open details to inspect the merged provider config and exact backend field names.',
        terms: [
          { label: 'OIDC', value: 'OpenID Connect; identity metadata and tokens built on OAuth 2.0.' },
          { label: 'Issuer', value: 'The authority URL that signs or describes identity tokens.' },
        ],
        notes: ['Secrets are masked in the terminal when present.', 'Use allowed token hosts to constrain outbound token endpoint calls.'],
      }
    case 'policy':
      return {
        title: 'Policy',
        meaning: 'A policy is authorization logic that evaluates a request and produces an allow, deny, or partial result.',
        when: 'Use policies to encode access rules that are more precise than static grants.',
        impact: 'Policy versions can affect live authorization once included in an active policy set.',
        example: 'allow PiperNet read during business hours',
        valid: 'Policy content is validated before save; versions are immutable once created.',
        after: 'Open details to inspect metadata; validate before adding or activating a new version.',
        terms: [
          { label: 'Version', value: 'An immutable copy of policy content that can be referenced by policy sets.' },
          { label: 'Partial', value: 'A decision that needs additional runtime enforcement or Gateway context.' },
        ],
        notes: ['Use validate before creating a version from pasted or file content.', 'Policy details do not replace policy-set activation status.'],
      }
    case 'policy set':
      return {
        title: 'Policy set',
        meaning: 'A policy set groups specific policy versions and controls which authorization logic is active.',
        when: 'Use policy sets to promote tested policy versions into live evaluation.',
        impact: 'Activating a policy-set version changes the policy bundle used for new authorization decisions.',
        example: 'PiperNet baseline v3',
        valid: 'A policy set version references immutable policy version IDs.',
        after: 'Use simulate before activation when you need decision confidence for a concrete input.',
        terms: [
          { label: 'Manifest', value: 'The list of policy version IDs included in one policy-set version.' },
          { label: 'Shadow', value: 'An optional comparison version used to evaluate changes without replacing primary behavior.' },
        ],
        notes: ['Activations are operational changes; copy-page can capture the active version and manifest for change records.'],
      }
    case 'grant':
      return {
        title: 'Grant',
        meaning: 'A grant binds an application, subject, resource, and scopes into explicit authority.',
        when: 'Use grants for known subjects or workloads that need scoped access to one resource.',
        impact: 'Grants establish requestable authority; policies can still narrow or deny individual requests.',
        example: 'Son of Anton -> Bertram Gilfoyle -> resource://pipernet read',
        valid: 'The resource and application must exist in the selected zone; scopes should come from the selected resource.',
        after: 'Open details to inspect status, subject, scopes, and linked object IDs before revoking.',
        terms: [
          { label: 'Subject', value: 'The end user, workload, or actor receiving authority through the grant.' },
          { label: 'Revoke', value: 'Stops future use of the grant while keeping an audit trail.' },
        ],
        notes: ['Use the scope picker after selecting a resource to avoid invalid scope strings.'],
      }
    case 'session':
      return {
        title: 'Session',
        meaning: 'A session is a tracked authority context created by token exchange, delegation, or agent activity.',
        when: 'Use sessions to inspect active, expired, or revoked authority for a subject.',
        impact: 'Session status affects whether related authority can continue to be used.',
        example: 'Richard Hendricks active until 28 May, 04:48 UTC',
        valid: 'Filters narrow by status, subject, and result limit.',
        after: 'Use audit and delegation views for deeper request history or authority graph inspection.',
        terms: [
          { label: 'TTL', value: 'Time to live; how long a token or authority record remains valid.' },
          { label: 'Revoked', value: 'Explicitly invalidated before natural expiration.' },
        ],
        notes: ['Session timestamps are formatted for reading in tables; detail JSON preserves raw backend values where available.'],
      }
    case 'delegation':
      return {
        title: 'Delegation',
        meaning: 'A delegation edge transfers bounded authority from one session to another.',
        when: 'Use delegation views to trace, traverse, or revoke authority passed between agents or sessions.',
        impact: 'Revoking a delegation can cut off downstream authority paths and affect active agents.',
        example: 'Son of Anton session -> Fiona session for resource://pipernet',
        valid: 'Edges are zone-scoped and can be inspected by active, inbound, outbound, or traversal views.',
        after: 'Open details or traverse to understand the exact edge before revocation.',
        terms: [
          { label: 'Inbound', value: 'Delegations targeting the selected session.' },
          { label: 'Outbound', value: 'Delegations issued by the selected session.' },
        ],
        notes: ['Traversal is diagnostic; revoke is a state-changing authority operation.'],
      }
    case 'agent':
      return {
        title: 'Agent run',
        meaning: 'An agent run is an operational session for an agent application and its child activity.',
        when: 'Use agent views to inspect status, parent/child trees, suspension, resume, and termination.',
        impact: 'Suspend and terminate affect live agent execution; tree inspection is read-only.',
        example: 'Son of Anton running depth 1',
        valid: 'Agent rows come from the coordinator for the selected zone.',
        after: 'Open details for raw session state or tree for child-session relationships.',
        terms: [
          { label: 'Depth', value: 'How far the session is from the root agent session.' },
          { label: 'Suspend', value: 'Pause an agent session subtree without deleting its records.' },
        ],
        notes: ['Use terminate for cleanup only when the session should stop permanently.'],
      }
  }
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

function providerConfigForEdit(currentKind: ProviderKind, nextKind: ProviderKind, existingConfig: JsonObject, filePath: string, inline: string): JsonObject | undefined {
  const config = providerConfig(filePath, inline)
  if (config) {
    validateProviderConfig(nextKind, config)
    return config
  }
  if (currentKind !== nextKind) validateProviderConfig(nextKind, existingConfig)
  return undefined
}

function providerConfigFromValues(values: Record<string, string>, requireConfig: boolean): JsonObject | undefined {
  const kind = providerKind(values.kind)
  const config = providerConfig(values.config_file ?? '', values.config_json ?? '') ?? {}
  mergeConfigText(config, 'issuer', values.issuer)
  mergeConfigText(config, 'authorization_endpoint', values.authorization_endpoint)
  mergeConfigText(config, 'token_endpoint', values.token_endpoint || values.workload_token_endpoint)
  mergeConfigList(config, 'allowed_token_hosts', values.allowed_token_hosts || values.workload_allowed_token_hosts || inferredTokenHosts(values.token_endpoint || values.workload_token_endpoint))
  mergeConfigList(config, 'upstream_oauth_scopes', values.upstream_oauth_scopes)
  mergeConfigText(config, 'header_name', values.api_key_header)
  mergeConfigText(config, 'auth_scheme', values.auth_scheme)
  mergeConfigText(config, 'audience', values.workload_audience)
  if (values.forward_caracal_identity === 'true') config.forward_caracal_identity = true
  if (Object.keys(config).length === 0) {
    if (requireConfig) throw new Error(`${kind} provider config is required`)
    return undefined
  }
  validateProviderConfig(kind, config)
  return config
}

function providerKind(value: string | undefined): ProviderKind {
  return PROVIDER_KINDS.includes(value as ProviderKind) ? value as ProviderKind : 'oauth2'
}

function mergeConfigText(config: JsonObject, key: string, value: string | undefined): void {
  const text = value?.trim()
  if (text) config[key] = text
}

function mergeConfigList(config: JsonObject, key: string, value: string | undefined): void {
  const items = splitList(value ?? '')
  if (items.length > 0) config[key] = items
}

function validateProviderConfig(kind: ProviderKind, config: JsonObject): void {
  if ('scopes' in config) throw new Error('provider config uses upstream_oauth_scopes; resource forms use Caracal scopes')
  const allowed = providerConfigKeys(kind)
  const unknown = Object.keys(config).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${kind} provider config has unsupported keys: ${unknown.join(', ')}`)
  if (kind === 'apikey') {
    requireString(config, 'header_name', 'apikey provider config requires header_name')
    return
  }
  if (kind === 'workload') {
    requireString(config, 'issuer', 'workload provider config requires issuer')
    requireString(config, 'audience', 'workload provider config requires audience')
    requireString(config, 'token_endpoint', 'workload provider config requires token_endpoint')
    requireStringList(config, 'allowed_token_hosts', 'workload provider config requires allowed_token_hosts')
    return
  }
  if (kind === 'oidc') requireString(config, 'issuer', 'oidc provider config requires issuer')
  requireString(config, 'token_endpoint', `${kind} provider config requires token_endpoint`)
  requireStringList(config, 'allowed_token_hosts', `${kind} provider config requires allowed_token_hosts`)
}

function providerConfigKeys(kind: ProviderKind): Set<string> {
  if (kind === 'apikey') return new Set(['header_name', 'auth_scheme', 'forward_caracal_identity'])
  if (kind === 'workload') return new Set(['issuer', 'audience', 'token_endpoint', 'allowed_token_hosts', 'subject_token_type', 'auth_header', 'auth_scheme', 'forward_caracal_identity'])
  return new Set(['issuer', 'authorization_endpoint', 'token_endpoint', 'allowed_token_hosts', 'upstream_oauth_scopes', 'auth_header', 'auth_scheme', 'forward_caracal_identity'])
}

function requireString(config: JsonObject, key: string, message: string): void {
  if (typeof config[key] !== 'string' || config[key].trim().length === 0) throw new Error(message)
}

function requireStringList(config: JsonObject, key: string, message: string): void {
  const value = config[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(message)
  }
}

function int(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined
  if (!/^[1-9]\d*$/.test(v.trim())) throw new Error('value must be a positive integer')
  const n = Number.parseInt(v, 10)
  return n
}

function requireClientSecret(value: string | undefined): string {
  if (!value) throw new Error('application response did not include the one-time client secret')
  return value
}

async function popAndReload(app: App, list: ListView<unknown>): Promise<void> {
  app.pop()
  await list.reload()
}

function shortValue(value: string): string {
  if (value.length <= 12) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function named(row: { id: string; name?: string | null; identifier?: string | null; slug?: string | null }): string {
  return row.name || row.identifier || row.slug || row.id
}

function labelMap<T>(rows: T[], value: (row: T) => string, label: (row: T) => string): Map<string, string> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const text = label(row)
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return new Map(rows.map((row) => {
    const id = value(row)
    const text = label(row)
    return [id, (counts.get(text) ?? 0) > 1 ? `${text} (${shortValue(id)})` : text]
  }))
}

function resolveFromList<T>(load: () => Promise<T[]>, value: (row: T) => string, label: (row: T) => string): Field['resolve'] {
  let cached: Map<string, string> | undefined
  return async (id: string) => {
    cached = cached ?? labelMap(await load(), value, label)
    return cached.get(id)
  }
}

function applicationResolver(ctx: Ctx): Field['resolve'] {
  return resolveFromList(() => ctx.client.applications.list(ctx.zoneId), (row) => row.id, (row) => row.name)
}

function resourceResolver(ctx: Ctx): Field['resolve'] {
  return resolveFromList(async () => userResources(await ctx.client.resources.list(ctx.zoneId)), (row) => row.id, named)
}

function resourceIdentifierResolver(ctx: Ctx): Field['resolve'] {
  return resolveFromList(async () => userResources(await ctx.client.resources.list(ctx.zoneId)), (row) => row.identifier, named)
}

function providerResolver(ctx: Ctx): Field['resolve'] {
  return resolveFromList(() => ctx.client.providers.list(ctx.zoneId), (row) => row.id, named)
}

function sessionResolver(ctx: Ctx): Field['resolve'] {
  return resolveFromList(() => ctx.client.sessions.list(ctx.zoneId, { status: 'active', limit: 100 }), (row) => row.id, (row) => row.subject_id)
}

async function loadPolicyVersions(ctx: Ctx): Promise<PolicyVersionRow[]> {
  const policies = await ctx.client.policies.list(ctx.zoneId)
  const details = await Promise.all(policies.map((policy) => ctx.client.policies.get(ctx.zoneId, policy.id)))
  return details.flatMap((policy) => (policy.versions ?? []).map((version) => ({ ...version, policy_name: policy.name })))
}

function policyVersionLabel(row: PolicyVersionRow): string {
  return `${row.policy_name} v${row.version}`
}

function policyVersionResolver(ctx: Ctx): Field['resolve'] {
  return resolveFromList(() => loadPolicyVersions(ctx), (row) => row.id, policyVersionLabel)
}

async function loadPolicySetVersions(ctx: Ctx, policySet: PolicySet): Promise<PolicySetVersionRow[]> {
  const detail = await ctx.client.policySets.get(ctx.zoneId, policySet.id) as PolicySet & { versions?: PolicySetVersion[] }
  return (detail.versions ?? []).map((version) => ({ ...version, policy_set_name: policySet.name }))
}

function policySetVersionLabel(row: PolicySetVersionRow): string {
  return `${row.policy_set_name} v${row.version}`
}

function policySetVersionResolver(ctx: Ctx, policySet: PolicySet): Field['resolve'] {
  return resolveFromList(() => loadPolicySetVersions(ctx, policySet), (row) => row.id, policySetVersionLabel)
}

async function loadPolicySets(ctx: Ctx): Promise<PolicySetRow[]> {
  const rows = await ctx.client.policySets.list(ctx.zoneId)
  const details = await Promise.all(rows.map((row) => ctx.client.policySets.get(ctx.zoneId, row.id) as Promise<PolicySet & { versions?: PolicySetVersion[] }>))
  return rows.map((row, index) => {
    const versions = details[index]?.versions ?? []
    const active = versions.find((version) => version.id === row.active_version_id)
    return { ...row, active_version_label: active ? `v${active.version}` : row.active_version_id ? 'active' : '(none)' }
  })
}

async function loadGrants(ctx: Ctx): Promise<GrantRow[]> {
  const resourcesPromise = ctx.client.resources.list(ctx.zoneId).then(userResources)
  const [grants, applications, resources] = await Promise.all([
    ctx.client.grants.list(ctx.zoneId),
    ctx.client.applications.list(ctx.zoneId),
    resourcesPromise,
  ])
  const applicationNames = labelMap(applications, (row) => row.id, (row) => row.name)
  const resourceNames = labelMap(resources, (row) => row.id, named)
  return grants.map((grant) => ({
    ...grant,
    application_name: applicationNames.get(grant.application_id) ?? grant.application_id,
    resource_name: resourceNames.get(grant.resource_id) ?? grant.resource_id,
  }))
}

async function loadAgents(ctx: Ctx): Promise<AgentRow[]> {
  const agents = await ctx.client.agents.list(ctx.zoneId)
  return agents.map((agent) => ({ ...agent, application_name: agent.application_id }))
}

async function labelDelegations(ctx: Ctx, rows: DelegationEdge[]): Promise<DelegationRow[]> {
  const resources = userResources(await ctx.client.resources.list(ctx.zoneId))
  const resourceNames = labelMap(resources, (row) => row.id, named)
  return rows.map((row) => ({ ...row, resource_name: row.resource_id ? resourceNames.get(row.resource_id) ?? row.resource_id : undefined }))
}

export function applicationPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Application>(
    'pick application',
    () => ctx.client.applications.list(ctx.zoneId),
    [
      { header: 'name', width: 24, value: (row) => row.name },
    ],
    (row) => row.id,
    (row) => row.name,
  )
}

function resourcePicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Resource>(
    'pick resource',
    async () => userResources(await ctx.client.resources.list(ctx.zoneId)),
    [
      { header: 'name', width: 24, value: named },
      { header: 'identifier', width: 30, value: (row) => row.identifier },
      { header: 'Caracal scopes', width: 28, value: (row) => (row.scopes ?? []).join(',') || '-' },
    ],
    (row) => row.id,
    named,
  )
}

export function resourceIdentifierPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Resource>(
    'pick resource',
    async () => userResources(await ctx.client.resources.list(ctx.zoneId)),
    [
      { header: 'name', width: 24, value: named },
      { header: 'identifier', width: 30, value: (row) => row.identifier },
      { header: 'Caracal scopes', value: (row) => (row.scopes ?? []).join(',') || '-' },
    ],
    (row) => row.identifier,
    named,
  )
}

function providerPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Provider>(
    'pick provider',
    () => ctx.client.providers.list(ctx.zoneId),
    [
      { header: 'name', width: 24, value: named },
      { header: 'identifier', width: 24, value: (row) => row.identifier },
      { header: 'kind', width: 10, value: (row) => row.kind ?? '-' },
    ],
    (row) => row.id,
    named,
  )
}

function sessionPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<Session>(
    'pick active session',
    () => ctx.client.sessions.list(ctx.zoneId, { status: 'active', limit: 100 }),
    [
      { header: 'subject', width: 30, value: (row) => row.subject_id },
      { header: 'type', width: 10, value: (row) => row.session_type },
      { header: 'status', value: (row) => row.status },
    ],
    (row) => row.id,
    (row) => row.subject_id,
  )
}

function delegationPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<DelegationRow>(
    'pick delegation',
    async () => labelDelegations(ctx, (await ctx.client.delegations.active(ctx.zoneId)).items),
    [
      { header: 'source', width: 28, value: (row) => row.source_session_id },
      { header: 'target', width: 28, value: (row) => row.target_session_id },
      { header: 'resource', value: (row) => row.resource_name ?? row.resource_id ?? '-' },
    ],
    (row) => row.id,
    (row) => `${row.source_session_id} → ${row.target_session_id}`,
  )
}

function policyVersionPicker(ctx: Ctx): Field['pick'] {
  return pickFromList<PolicyVersionRow>(
    'pick policy version',
    () => loadPolicyVersions(ctx),
    [
      { header: 'policy', width: 24, value: (row) => row.policy_name },
      { header: 'version', width: 8, value: (row) => String(row.version) },
      { header: 'schema', value: (row) => row.schema_version },
    ],
    (row) => row.id,
    policyVersionLabel,
    appendCsv,
  )
}

function policySetVersionPicker(ctx: Ctx, policySet: PolicySet): Field['pick'] {
  return pickFromList<PolicySetVersionRow>(
    'pick policy set version',
    () => loadPolicySetVersions(ctx, policySet),
    [
      { header: 'policy set', width: 24, value: (row) => row.policy_set_name },
      { header: 'version', width: 8, value: (row) => String(row.version) },
      { header: 'schema', value: (row) => row.schema_version },
    ],
    (row) => row.id,
    policySetVersionLabel,
  )
}

function grantScopePicker(ctx: Ctx): Field['pick'] {
  return (app, setValue, current, values) => {
    const resourceId = values.resource_id?.trim()
    if (!resourceId) {
      app.setStatus('choose a resource before picking grant scopes', 'error')
      return
    }
    app.push(new EntityPickerView<string>({
      title: 'pick grant scope',
      load: async () => {
        const resource = await ctx.client.resources.get(ctx.zoneId, resourceId)
        return resource.scopes ?? []
      },
      value: (scope) => scope,
      label: (scope) => scope,
      description: () => 'scope on selected resource',
      onPick: (scope) => setValue(appendCsv(current, scope)),
      info: infoPage({
        title: 'Grant scope',
        meaning: 'A grant scope is a subset of the selected resource scopes.',
        when: 'Use it to narrow what the selected application may request for this subject.',
        example: 'read',
        valid: 'Choose one of the scopes defined on the selected resource.',
        after: 'The selected scope is added to the grant; policies can narrow it further.',
      }),
    }))
  }
}

export function zonesView(ctx: Ctx): View {
  const list: ListView<Zone> = new ListView<Zone>({
    title: 'zones',
    info: resourceListInfo('zone'),
    columns: [
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'slug', width: 18, value: (r) => r.slug },
      { header: 'dynamic clients', width: 15, value: (r) => (r.dcr_enabled ? 'enabled' : 'disabled') },
    ],
    load: () => ctx.client.zones.list(),
    state: ctx.state,
    stateKey: 'zones',
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: named,
    onEnter: (app, row) => {
      ctx.onZoneSelect?.(row.id, row.slug)
      app.setStatus(`zone set to ${row.name}`)
      open(app, entityDetail(`zone / ${row.name}`, () => ctx.client.zones.get(row.id)))
    },
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create zone',
          fields: [
            {
              key: 'name',
              label: 'name',
              kind: 'text',
              required: true,
              info: infoPage({
                title: 'Application name',
                meaning: 'Human-readable name for the agent, service, gateway, or client identity being created.',
                when: 'Use the name operators will recognize when selecting this application in grants, resources, and audit views.',
                impact: 'Console sends this name to the Application API and shows it in lists, pickers, details, setup output, and generated profile summaries.',
                example: 'Son of Anton',
                valid: 'Required for this path. Use a short operational name, not an internal database ID.',
                after: 'After submit, Console creates the application and shows the one-time client secret when the backend accepts the request.',
                terms: [
                  { label: 'Application', value: 'A client identity used by workloads, agents, gateways, or automation to request Caracal tokens.' },
                ],
              }),
            },
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
            ],
            onSubmit: async (v, app) => {
              await ctx.client.zones.patch(row.id, {
                name: v.name || undefined,
                slug: v.slug || undefined,
                dcr_enabled: bool(v.dcr_enabled),
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
    info: resourceListInfo('application'),
    columns: [
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'method', width: 8, value: (r) => r.registration_method },
    ],
    load: () => ctx.client.applications.list(ctx.zoneId),
    state: ctx.state,
    stateKey: 'applications',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: (row) => row.name,
    onEnter: (app, row) => open(app, applicationDetail(`app / ${row.name}`, () => ctx.client.applications.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create application',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            {
              key: 'registration_method',
              label: 'registration method',
              kind: 'select',
              options: [...APPLICATION_REGISTRATION_METHODS],
              default: 'managed',
              info: infoPage({
                title: 'Application registration method',
                meaning: 'Choose how this application identity should be created and owned.',
                when: 'Use managed for known durable agents, services, workers, gateways, CI jobs, and integrations that an operator intentionally provisions. Use DCR for dynamic, self-service, high-churn, or ephemeral agents and clients when the selected zone enables dynamic clients.',
                impact: 'Managed creation writes the application directly through the admin API. DCR calls the Dynamic Client Registration path and is blocked when the zone has dynamic clients disabled.',
                example: 'managed for Son of Anton; dcr for a short-lived Fiona task agent',
                valid: 'Choose managed or dcr.',
                after: 'Console shows only the fields relevant to the selected registration path before submitting.',
                terms: [
                  { label: 'Managed', value: 'Operator-provisioned application with an intentional lifecycle and stable identity.' },
                  { label: 'DCR', value: 'Dynamic Client Registration; API-driven app registration for self-service or ephemeral clients.' },
                ],
                notes: ['Permanent known agents normally use managed.', 'Ephemeral or self-registering agents normally use DCR, with zone-level limits and cleanup.'],
              }),
            },
            {
              key: 'expires_in',
              label: 'client lifetime seconds',
              kind: 'text',
              default: '3600',
              dependsOn: { registration_method: 'dcr' },
              validate: (v) => {
                if (v && !/^[1-9]\d*$/.test(v.trim())) return 'client lifetime must be a positive integer'
                if (v && Number.parseInt(v.trim(), 10) > 3600) return 'client lifetime must be 3600 seconds or less'
                return undefined
              },
              info: infoPage({
                title: 'Client lifetime seconds',
                meaning: 'DCR client lifetime expressed as seconds from creation time.',
                when: 'Use this to keep ephemeral DCR clients short-lived. The default is one hour and the API caps DCR clients at one hour.',
                impact: 'The DCR API stores an expires_at timestamp. Expired applications are hidden from active references, denied by STS token authentication, and later archived by DCR cleanup.',
                example: '3600',
                valid: 'Required for this path. Enter a positive integer from 1 to 3600 seconds.',
                after: 'After submit, Console sends expires_in to the DCR endpoint and shows the generated client secret once.',
                terms: [
                  { label: 'DCR', value: 'Dynamic Client Registration for self-service or ephemeral application identities.' },
                  { label: 'expires_at', value: 'Backend timestamp derived from the submitted lifetime in seconds.' },
                ],
              }),
            },
          ],
          onSubmit: async (v, app) => {
            if (v.registration_method === 'dcr') {
              const application = await ctx.client.applications.dcr(ctx.zoneId, {
                name: v.name!,
                expires_in: int(v.expires_in),
              })
              const clientSecret = requireClientSecret(application.client_secret)
              await popAndReload(app, list as unknown as ListView<unknown>)
              open(app, new DetailView({
                title: `app / ${application.name}`,
                load: async () => ({
                  id: application.id,
                  zone_id: application.zone_id,
                  name: application.name,
                  registration_method: application.registration_method,
                  expires_at: (application as { expires_at?: string }).expires_at,
                  client_secret: clientSecret,
                  note: 'store client_secret now - it cannot be retrieved later',
                }),
                mask: maskSecretField,
              }))
              return
            }
            const application = await ctx.client.applications.create(ctx.zoneId, {
              name: v.name!,
              registration_method: 'managed',
            })
            const clientSecret = requireClientSecret(application.client_secret)
            await popAndReload(app, list as unknown as ListView<unknown>)
            open(app, new DetailView({
              title: `app / ${application.name}`,
              load: async () => ({
                id: application.id,
                zone_id: application.zone_id,
                name: application.name,
                registration_method: application.registration_method,
                client_secret: clientSecret,
                note: 'store client_secret now - it cannot be retrieved later',
              }),
              mask: maskSecretField,
            }))
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
            ],
            onSubmit: async (v, app) => {
              await ctx.client.applications.patch(ctx.zoneId, row.id, {
                name: v.name || undefined,
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
    ],
  })
  return list
}

export function resourcesView(ctx: Ctx): View {
  const list: ListView<Resource> = new ListView<Resource>({
    title: 'resources',
    info: resourceListInfo('resource'),
    columns: [
      { header: 'name', width: 24, value: named },
      { header: 'identifier', width: 30, value: (r) => r.identifier },
      { header: 'upstream', width: 32, value: (r) => r.upstream_url ?? '-' },
      { header: 'Caracal scopes', value: (r) => (r.scopes ?? []).join(' ') || '-' },
    ],
    load: async () => userResources(await ctx.client.resources.list(ctx.zoneId)),
    state: ctx.state,
    stateKey: 'resources',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: named,
    onEnter: (app, row) => open(app, entityDetail(`resource / ${named(row)}`, () => ctx.client.resources.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create resource',
          submitLabel: 'create resource',
          fields: [
            { key: 'name', label: 'resource name', kind: 'text', required: true, hint: 'human-readable name; identifier is generated when blank' },
            { key: 'scopes', label: 'Caracal scopes', kind: 'list', required: true, hint: 'comma-separated authorization scopes for this resource' },
            { key: 'mode', label: 'integration mode', kind: 'select', options: [...RESOURCE_MODES], default: 'direct', hint: 'direct protects an audience only; gateway adds upstream routing fields' },
            { key: 'upstream_url', label: 'upstream URL', kind: 'text', required: true, dependsOn: { mode: 'gateway' }, hint: 'Gateway target for REST APIs, gRPC gateways, MCP servers, or SDK-backed services' },
            { key: 'identifier', label: 'identifier', kind: 'text', advanced: true, hint: 'optional; generated as resource://pipernet when blank' },
            { key: 'gateway_application_id', label: 'gateway app', kind: 'text', dependsOn: { mode: 'gateway' }, advanced: true, pick: applicationPicker(ctx), resolve: applicationResolver(ctx), hint: 'only when Gateway should exchange as a specific app' },
            { key: 'prefix', label: 'prefix match', kind: 'bool', default: 'true', dependsOn: { mode: 'gateway' }, advanced: true, hint: 'enabled by default for Gateway-routed API, gRPC, and MCP paths' },
            { key: 'credential_provider_id', label: 'credential provider', kind: 'text', dependsOn: { mode: 'gateway' }, advanced: true, pick: providerPicker(ctx), resolve: providerResolver(ctx), hint: 'only when the upstream service needs provider-side credentials' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.resources.create(ctx.zoneId, {
              identifier: v.identifier || resourceIdentifierFromName(v.name!),
              scopes: splitList(v.scopes ?? ''),
              name: v.name,
              upstream_url: v.upstream_url || undefined,
              gateway_application_id: v.gateway_application_id || undefined,
              prefix: v.upstream_url ? bool(v.prefix) : undefined,
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
              { key: 'mode', label: 'integration mode', kind: 'select', options: [...RESOURCE_MODES], default: row.upstream_url ? 'gateway' : 'direct' },
              { key: 'upstream_url', label: 'upstream URL', kind: 'text', default: row.upstream_url ?? '', required: true, dependsOn: { mode: 'gateway' } },
              { key: 'gateway_application_id', label: 'gateway app', kind: 'text', default: row.gateway_application_id ?? '', dependsOn: { mode: 'gateway' }, pick: applicationPicker(ctx), resolve: applicationResolver(ctx) },
              { key: 'credential_provider_id', label: 'credential provider', kind: 'text', default: row.credential_provider_id ?? '', dependsOn: { mode: 'gateway' }, pick: providerPicker(ctx), resolve: providerResolver(ctx), hint: 'only when the upstream service needs provider-side credentials' },
              { key: 'prefix', label: 'prefix match', kind: 'bool', default: String(row.prefix), dependsOn: { mode: 'gateway' } },
              { key: 'scopes', label: 'Caracal scopes', kind: 'list', default: (row.scopes ?? []).join(','), hint: 'comma-separated authorization scopes for this resource' },
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
    info: resourceListInfo('provider'),
    columns: [
      { header: 'name', width: 24, value: named },
      { header: 'identifier', width: 24, value: (r) => r.identifier },
      { header: 'kind', width: 10, value: (r) => r.kind ?? '-' },
      { header: 'owner', width: 10, value: (r) => r.owner_type },
    ],
    load: () => ctx.client.providers.list(ctx.zoneId),
    state: ctx.state,
    stateKey: 'providers',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: named,
    onEnter: (app, row) => open(app, entityDetail(`provider / ${named(row)}`, () => ctx.client.providers.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create provider',
          submitLabel: 'create provider',
          fields: [
            { key: 'name', label: 'provider name', kind: 'text', required: true, hint: 'human-readable name; identifier is generated when blank' },
            { key: 'kind', label: 'provider type', kind: 'select', options: PROVIDER_KINDS, default: 'oauth2' },
            { key: 'issuer', label: 'issuer', kind: 'text', dependsOn: { kind: ['oauth2', 'oidc', 'workload'] }, required: (values) => {
              const kind = providerKind(values.kind)
              return kind === 'oidc' || kind === 'workload'
            }, hint: 'issuer URL for OIDC discovery or workload identity trust' },
            { key: 'authorization_endpoint', label: 'authorization endpoint', kind: 'text', dependsOn: { kind: ['oauth2', 'oidc'] }, hint: 'OAuth authorization endpoint used by browser or consent flows' },
            { key: 'token_endpoint', label: 'token endpoint', kind: 'text', dependsOn: { kind: ['oauth2', 'oidc'] }, required: true, hint: 'HTTPS endpoint where provider tokens are exchanged or refreshed' },
            { key: 'upstream_oauth_scopes', label: 'upstream OAuth scopes', kind: 'list', dependsOn: { kind: ['oauth2', 'oidc'] }, hint: 'provider-side scopes, separate from Caracal resource scopes' },
            { key: 'api_key_header', label: 'API key header', kind: 'text', dependsOn: { kind: 'apikey' }, required: true, hint: 'header where the upstream service expects the API key' },
            { key: 'workload_audience', label: 'audience', kind: 'text', dependsOn: { kind: 'workload' }, required: true, hint: 'audience value expected by the workload identity provider' },
            { key: 'workload_token_endpoint', label: 'token endpoint', kind: 'text', dependsOn: { kind: 'workload' }, required: true, hint: 'HTTPS endpoint where workload tokens are exchanged' },
            { key: 'identifier', label: 'identifier', kind: 'text', advanced: true, hint: 'optional; generated from provider name when blank' },
            { key: 'client_id', label: 'client ID', kind: 'text', dependsOn: { kind: ['oauth2', 'oidc'] }, advanced: true },
            { key: 'allowed_token_hosts', label: 'allowed token hosts', kind: 'list', dependsOn: { kind: ['oauth2', 'oidc'] }, advanced: true, hint: 'optional; inferred from token endpoint when blank' },
            { key: 'auth_scheme', label: 'auth scheme', kind: 'text', dependsOn: { kind: 'apikey' }, advanced: true, hint: 'optional; leave blank when the upstream expects the raw token' },
            { key: 'workload_allowed_token_hosts', label: 'allowed token hosts', kind: 'list', dependsOn: { kind: 'workload' }, advanced: true, hint: 'optional; inferred from token endpoint when blank' },
            { key: 'forward_caracal_identity', label: 'forward Caracal identity', kind: 'bool', default: 'false', advanced: true },
            { key: 'config_file', label: 'provider config file', kind: 'file', advanced: true, hint: 'JSON object merged with the structured fields' },
            { key: 'config_json', label: 'advanced provider JSON', kind: 'multiline', advanced: true, hint: 'paste a JSON object; multiline paste is preserved; provider-specific keys are validated' },
          ],
          onSubmit: async (v, app) => {
            await ctx.client.providers.create(ctx.zoneId, {
              identifier: providerIdentifierFromValues(v),
              name: v.name || undefined,
              kind: providerKind(v.kind),
              client_id: v.client_id || undefined,
              config_json: providerConfigFromValues(v, true),
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
              { key: 'client_id', label: 'client ID', kind: 'text', default: row.client_id ?? '', dependsOn: { kind: ['oauth2', 'oidc'] } },
              { key: 'config_file', label: 'merge provider config file', kind: 'file', hint: 'JSON object; leave blank to keep existing config' },
              { key: 'config_json', label: 'merge advanced provider JSON', kind: 'multiline', hint: 'paste JSON object; leave blank to keep existing config' },
            ],
            onSubmit: async (v, app) => {
              await ctx.client.providers.patch(ctx.zoneId, row.id, {
                name: v.name || undefined,
                identifier: v.identifier || undefined,
                kind: providerKind(v.kind),
                client_id: v.client_id || undefined,
                config_json: providerConfigForEdit(providerKind(row.kind ?? ''), providerKind(v.kind), row.config_json, v.config_file ?? '', v.config_json ?? ''),
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
    info: resourceListInfo('policy'),
    columns: [
      { header: 'name', width: 28, value: (r) => r.name },
      { header: 'owner', width: 10, value: (r) => r.owner_type },
      { header: 'description', width: 32, value: (r) => r.description ?? '-' },
    ],
    load: () => ctx.client.policies.list(ctx.zoneId),
    state: ctx.state,
    stateKey: 'policies',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: (row) => row.name,
    onEnter: (app, row) => open(app, entityDetail(`policy / ${row.name}`, () => ctx.client.policies.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create policy',
          submitLabel: 'validate and create policy',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            { key: 'source', label: 'source', kind: 'select', options: [...CONTENT_SOURCES], default: 'paste' },
            { key: 'content', label: 'policy content', kind: 'multiline', required: true, dependsOn: { source: 'paste' } },
            { key: 'file', label: 'policy file', kind: 'file', required: true, dependsOn: { source: 'file' } },
            { key: 'description', label: 'description', kind: 'text', advanced: true },
          ],
          onSubmit: async (v, app) => {
            const content = readPolicyContent(v)
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
          submitLabel: 'validate policy',
          fields: [
            { key: 'source', label: 'source', kind: 'select', options: [...CONTENT_SOURCES], default: 'paste' },
            { key: 'content', label: 'policy content', kind: 'multiline', required: true, dependsOn: { source: 'paste' } },
            { key: 'file', label: 'policy file', kind: 'file', required: true, dependsOn: { source: 'file' } },
          ],
          onSubmit: async (v, app) => {
            const content = readPolicyContent(v)
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
            submitLabel: 'add policy version',
            fields: [
              { key: 'source', label: 'source', kind: 'select', options: [...CONTENT_SOURCES], default: 'paste' },
              { key: 'content', label: 'policy content', kind: 'multiline', required: true, dependsOn: { source: 'paste' } },
              { key: 'file', label: 'policy file', kind: 'file', required: true, dependsOn: { source: 'file' } },
            ],
            onSubmit: async (v, app) => {
              const content = readPolicyContent(v)
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
  const list: ListView<PolicySetRow> = new ListView<PolicySetRow>({
    title: 'policy sets',
    info: resourceListInfo('policy set'),
    columns: [
      { header: 'name', width: 24, value: (r) => r.name },
      { header: 'active version', width: 16, value: (r) => r.active_version_label },
      { header: 'description', value: (r) => r.description ?? '-' },
    ],
    load: () => loadPolicySets(ctx),
    state: ctx.state,
    stateKey: 'policy-sets',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: (row) => row.name,
    onEnter: (app, row) => open(app, entityDetail(`policy set / ${row.name}`, () => ctx.client.policySets.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create policy set',
          submitLabel: 'create policy set',
          fields: [
            { key: 'name', label: 'name', kind: 'text', required: true },
            { key: 'policy_versions', label: 'policy versions', kind: 'list', pick: policyVersionPicker(ctx), resolve: policyVersionResolver(ctx), hint: 'right arrow adds latest or selected policy versions' },
            { key: 'activate_now', label: 'activate now', kind: 'bool', default: 'true', dependsOn: 'policy_versions' },
            { key: 'description', label: 'description', kind: 'text', advanced: true },
          ],
          onSubmit: async (v, app) => {
            const policySet = await ctx.client.policySets.create(ctx.zoneId, v.name!, v.description || undefined)
            const manifest = splitList(v.policy_versions ?? '').map((policy_version_id) => ({ policy_version_id }))
            if (manifest.length > 0) {
              const version = await ctx.client.policySets.addVersion(ctx.zoneId, policySet.id, manifest)
              if (bool(v.activate_now)) await ctx.client.policySets.activate(ctx.zoneId, policySet.id, version.id)
            }
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
              { key: 'policy_versions', label: 'policy versions', kind: 'list', required: true, pick: policyVersionPicker(ctx), resolve: policyVersionResolver(ctx), hint: 'right arrow adds versions' },
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
              { key: 'version_id', label: 'version', kind: 'text', required: true, pick: policySetVersionPicker(ctx, row), resolve: policySetVersionResolver(ctx, row) },
              { key: 'shadow_version_id', label: 'shadow version', kind: 'text', advanced: true, pick: policySetVersionPicker(ctx, row), resolve: policySetVersionResolver(ctx, row) },
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
              { key: 'version_id', label: 'version', kind: 'text', required: true, default: row.active_version_id ?? '', pick: policySetVersionPicker(ctx, row), resolve: policySetVersionResolver(ctx, row) },
              { key: 'source', label: 'input source', kind: 'select', options: ['none', ...CONTENT_SOURCES], default: 'none' },
              { key: 'input_file', label: 'input file', kind: 'file', required: true, dependsOn: { source: 'file' } },
              { key: 'input', label: 'inline input', kind: 'multiline', required: true, dependsOn: { source: 'paste' }, hint: 'JSON object for a concrete simulation input' },
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
              app.push(detail(`policy set simulate / ${row.name}`, async () => result))
            },
          })
        },
      },
      {
        key: 'd', label: 'delete', build: (row) => {
          if (!row) throw new Error('no row selected')
          return new ConfirmView({
            message: `delete policy set ${row.name}?`,
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
  const list: ListView<GrantRow> = new ListView<GrantRow>({
    title: 'grants',
    info: resourceListInfo('grant'),
    columns: [
      { header: 'app', width: 28, value: (r) => r.application_name },
      { header: 'subject', width: 36, value: (r) => r.user_id },
      { header: 'resource', width: 28, value: (r) => r.resource_name },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'Caracal scopes', value: (r) => (r.scopes ?? []).join(' ') || '-' },
    ],
    load: () => loadGrants(ctx),
    state: ctx.state,
    stateKey: 'grants',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: (row) => `${row.application_name} → ${row.resource_name}`,
    onEnter: (app, row) => open(app, entityDetail(`grant / ${row.id}`, () => ctx.client.grants.get(ctx.zoneId, row.id))),
    actions: [
      {
        key: 'n', label: 'new', build: () => new FormView({
          title: 'create grant',
          submitLabel: 'create grant',
          fields: [
            { key: 'resource_id', label: 'resource', kind: 'text', required: true, pick: resourcePicker(ctx), resolve: resourceResolver(ctx) },
            { key: 'application_id', label: 'application', kind: 'text', required: true, pick: applicationPicker(ctx), resolve: applicationResolver(ctx) },
            { key: 'user_id', label: 'subject ID', kind: 'text', required: true, hint: 'opaque subject such as user:richard.hendricks@piedpiper.example or service:son-of-anton' },
            { key: 'scopes', label: 'Caracal scopes', kind: 'list', required: true, dependsOn: 'resource_id', pick: grantScopePicker(ctx), hint: 'choose from the selected resource scopes or enter comma-separated scopes' },
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
    info: resourceListInfo('session'),
    columns: [
      { header: 'subject', width: 36, value: (r) => r.subject_id },
      { header: 'type', width: 10, value: (r) => r.session_type },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'expires_at', width: 24, value: (r) => formatDateTimeOrValue(r.expires_at, { compact: true }) },
    ],
    load: () => ctx.client.sessions.list(ctx.zoneId, filters),
    state: ctx.state,
    stateKey: 'sessions',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: (row) => row.subject_id,
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

  hints(): string[] { return ['↑/↓:select', 'enter:open', '?:info', 'esc:back'] }

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
    if (key === '?') {
      const item = this.items[this.cursor]
      if (item) openInfo(ctx.app, infoPage({
        title: `Delegation ${item.label}`,
        meaning: 'Delegation views inspect or revoke edges between authority sessions.',
        when: 'Use this when delegated agent authority must be traced, audited, or revoked.',
        example: item.label,
        valid: 'Choose a delegation action, then pick a session or edge from the searchable picker.',
        after: 'Console opens the selected delegation view or mutation flow.',
      }))
      return
    }
    const direct = this.items.findIndex((item) => item.key === key)
    if (direct >= 0) { ctx.app.push(this.items[direct]!.build()); return }
    if (key === 'enter') ctx.app.push(this.items[this.cursor]!.build())
  }

  private edgeForm(kind: 'inbound' | 'outbound'): View {
    return new FormView({
      title: `delegation ${kind}`,
      fields: [{ key: 'session_id', label: 'session', kind: 'text', required: true, pick: sessionPicker(this.ctx), resolve: sessionResolver(this.ctx) }],
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

function delegationActiveView(ctx: Ctx): ListView<DelegationRow> {
  return new ListView<DelegationRow>({
    title: 'delegations / active',
    info: resourceListInfo('delegation'),
    columns: [
      { header: 'source', width: 36, value: (r) => r.source_session_id },
      { header: 'target', width: 36, value: (r) => r.target_session_id },
      { header: 'resource', width: 24, value: (r) => r.resource_name ?? '-' },
      { header: 'status', width: 10, value: (r) => r.status },
    ],
    load: async () => labelDelegations(ctx, (await ctx.client.delegations.active(ctx.zoneId)).items),
    state: ctx.state,
    stateKey: 'delegations-active',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: (row) => `${row.source_session_id} → ${row.target_session_id}`,
    onEnter: (app, row) => open(app, entityDetail(`delegation / ${row.id}`, async () => row)),
  })
}

function delegationEdgesView(ctx: Ctx, kind: 'inbound' | 'outbound', sessionId: string): ListView<DelegationRow> {
  const list: ListView<DelegationRow> = new ListView<DelegationRow>({
    title: `delegations / ${kind}`,
    info: resourceListInfo('delegation'),
    columns: [
      { header: 'source', width: 36, value: (r) => r.source_session_id },
      { header: 'target', width: 36, value: (r) => r.target_session_id },
      { header: 'resource', width: 24, value: (r) => r.resource_name ?? '-' },
      { header: 'status', width: 10, value: (r) => r.status },
    ],
    load: async () => labelDelegations(ctx, kind === 'inbound'
      ? await ctx.client.delegations.inbound(ctx.zoneId, sessionId)
      : await ctx.client.delegations.outbound(ctx.zoneId, sessionId)),
    state: ctx.state,
    stateKey: `delegations-${kind}-${sessionId}`,
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: (row) => `${row.source_session_id} → ${row.target_session_id}`,
    onEnter: (app, row) => open(app, entityDetail(`delegation / ${row.id}`, async () => row)),
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
    info: resourceListInfo('delegation'),
    columns: [
      { header: 'depth', width: 6, value: (r) => String(r.depth) },
      { header: 'source', width: 36, value: (r) => r.source_session_id },
      { header: 'target', width: 36, value: (r) => r.target_session_id },
    ],
    load: () => ctx.client.delegations.traverse(ctx.zoneId, id),
    state: ctx.state,
    stateKey: `delegation-traverse-${id}`,
    zoneId: ctx.zoneId,
    rowKey: (row) => row.id,
    rowId: (row) => row.id,
    rowName: (row) => `${row.source_session_id} → ${row.target_session_id}`,
    onEnter: (app, row) => open(app, entityDetail(`delegation-node / ${row.id}`, async () => row)),
  })
}

export function agentsView(ctx: Ctx): View {
  const list: ListView<AgentRow> = new ListView<AgentRow>({
    title: 'agents',
    info: resourceListInfo('agent'),
    columns: [
      { header: 'application', width: 28, value: (r) => r.application_name },
      { header: 'parent', width: 36, value: (r) => r.parent_id ?? '-' },
      { header: 'status', width: 10, value: (r) => r.status },
      { header: 'depth', width: 6, value: (r) => String(r.depth) },
      { header: 'spawned_at', width: 24, value: (r) => formatDateTimeOrValue(r.spawned_at, { compact: true }) },
    ],
    load: () => loadAgents(ctx),
    state: ctx.state,
    stateKey: 'agents',
    zoneId: ctx.zoneId,
    rowKey: (row) => row.agent_session_id,
    rowId: (row) => row.agent_session_id,
    rowName: (row) => row.application_name,
    onEnter: (app, row) => open(app, entityDetail(`agent / ${row.agent_session_id}`, () => ctx.client.agents.get(ctx.zoneId, row.agent_session_id))),
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
