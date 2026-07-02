// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Idempotent provisioner for the reserved caracal.sys system zone the Operator self-governs through the control plane.

import { createHash } from 'node:crypto'
import type { AdminClient, Application } from '@caracalai/admin'
import { ensureControlResource } from '@caracalai/engine'
import { CONTROL_CAPABILITIES } from './operator-control-map.js'

// The reserved system zone, encoded per the caracal.sys namespace standard: a slug in the
// caracal-sys- form and a name in the caracal.sys/ form. Both are reserved, so only a
// global-scope platform actor may create them — exactly the bootstrap admin identity the
// provisioner runs as.
export const SYSTEM_ZONE_SLUG = 'caracal-sys-internal'
export const SYSTEM_ZONE_NAME = 'caracal.sys/system'

// The Operator's reserved control identity inside the system zone, named in the reserved
// caracal.sys/ form so a tenant can never create or impersonate it.
export const OPERATOR_APP_NAME = 'caracal.sys/operator'

const CONTROL_INVOKE_TRAIT = 'control:invoke'
const CONTROL_SCOPE_TRAIT_PREFIX = 'control:scope:'

// The least-privilege control scopes the Operator identity is granted: exactly the union
// of every governed-executable capability's scopes, so the identity can do everything the
// Operator may execute and nothing more. Adding a governed capability widens this set on
// the next provision; it never silently over-grants.
export function operatorControlScopes(): string[] {
  const scopes = new Set<string>()
  for (const capability of Object.values(CONTROL_CAPABILITIES)) {
    for (const scope of capability.scopes) scopes.add(scope)
  }
  return [...scopes].sort()
}

// The canonical trait set for the Operator identity: control:invoke plus one control:scope:
// trait per least-privilege scope. The provisioner reconciles the live identity to exactly
// this set on every run, so a hand-narrowed or widened identity self-heals to least
// privilege.
export function operatorIdentityTraits(): string[] {
  return [CONTROL_INVOKE_TRAIT, ...operatorControlScopes().map((scope) => `${CONTROL_SCOPE_TRAIT_PREFIX}${scope}`)].sort()
}

// The resolved system-zone identity the Operator executes as: the system zone it governs
// and the application id of its reserved control identity. The client secret is supplied
// separately from sealed config and is never returned here. governedResources maps each
// governed upstream's id to the Caracal resource identifier the Operator routes its calls
// through, so the runtime can address the gateway by resource.
export interface SystemZoneIdentity {
  zoneId: string
  operatorApplicationId: string
  governedResources: { id: string; resourceIdentifier: string }[]
}

// A third-party upstream the Operator must reach without holding its key directly: the
// provider id, its base URL, and the secret key Caracal seals and injects at the gateway. The
// key is supplied only when it is being set or rotated; an upstream already sealed in a prior
// run carries no key here, and its provider is reconciled by identifier without re-sealing.
// A third-party upstream the Operator must reach without holding its key directly: the
// provider id, its base URL, the secret key Caracal seals and injects at the gateway, and where
// that key is injected. The key is supplied only when it is being set or rotated; an upstream
// already sealed in a prior run carries no key here, and its provider is reconciled by
// identifier without re-sealing. auth defaults to an Authorization Bearer header.
export interface UpstreamAuth {
  location: 'header' | 'query'
  headerName?: string
  authScheme?: string
  queryParamName?: string
}

export interface GovernedUpstream {
  id: string
  baseUrl: string
  apiKey?: string
  auth?: UpstreamAuth
}

// The reserved, single system-zone policy and policy-set that carry the Operator's
// data-plane grants. A zone has exactly one active policy-set, so the provisioner reuses
// these by name rather than creating a new one each run. The names are in the reserved
// caracal.sys/ form so a tenant can never author or replace them.
const OPERATOR_POLICY_NAME = 'caracal.sys/operator-bindings'
const OPERATOR_POLICY_SET_NAME = 'caracal.sys/operator-policy'
const OPERATOR_ROLE = 'operator'
const LLM_SCOPE = 'llm:invoke'
// The owning application bootstraps its session mandate by requesting this scope on a
// resource it owns, so every governed resource must declare it alongside its data scope.
const LIFECYCLE_SCOPE = 'agent:lifecycle'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sanitizeSlug(id: string): string {
  return (
    id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  )
}

function llmProviderIdentifier(id: string): `provider://${string}` {
  return `${LLM_PROVIDER_PREFIX}${sanitizeSlug(id)}`
}

export function llmResourceIdentifier(id: string): string {
  return `${LLM_RESOURCE_PREFIX}${sanitizeSlug(id)}`
}

// The reserved identifier prefixes every governed LLM provider and resource carries, so the
// pruner can find the objects this provisioner owns and remove the ones no longer configured
// without touching anything else in the system zone.
const LLM_PROVIDER_PREFIX = 'provider://caracal-sys-operator-llm-'
const LLM_RESOURCE_PREFIX = 'caracal-sys://operator-llm-'

// Authors the system zone's data-document policy: the platform decision contract reads
// app_ids and grants to decide a data-plane exchange, and this document supplies them for
// the Operator. The content is deterministic — resource identifiers are sorted and the
// objects are rendered as canonical JSON — so an unchanged grant set produces an identical
// document and the reconciler adds no new policy version.
export function authorOperatorPolicy(operatorAppId: string, resourceIdentifiers: string[]): string {
  const grants: Record<string, unknown> = {}
  for (const identifier of [...resourceIdentifiers].sort()) {
    grants[identifier] = { application: OPERATOR_ROLE, roles: { [OPERATOR_ROLE]: [LLM_SCOPE] } }
  }
  return [
    '# caracal:data-document',
    'package caracal.authz',
    'import rego.v1',
    `app_ids := ${JSON.stringify({ [OPERATOR_ROLE]: operatorAppId })}`,
    `grants := ${JSON.stringify(grants)}`,
    '',
  ].join('\n')
}

function sameTraitSet(live: readonly string[] | undefined, desired: readonly string[]): boolean {
  const have = new Set(live ?? [])
  return have.size === desired.length && desired.every((trait) => have.has(trait))
}

// Resolves the id of a zone by its exact slug, or null when no such zone exists. A
// deterministic lookup the provisioner depends on instead of scanning a page of the zone
// list: the system zone is created at first boot (the oldest zone), so in a deployment with
// more than one page of zones it would fall off the newest-first first page and a list scan
// would miss it — then try to create it and conflict on the unique slug. Looking it up by
// slug finds it regardless of zone count or archival, so provisioning stays convergent.
export type FindZoneBySlug = (slug: string) => Promise<{ id: string } | null>

async function ensureSystemZone(admin: AdminClient, findZoneBySlug: FindZoneBySlug): Promise<{ id: string }> {
  const existing = await findZoneBySlug(SYSTEM_ZONE_SLUG)
  if (existing) return existing
  return admin.zones.create({ name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG })
}

async function ensureOperatorIdentity(admin: AdminClient, zoneId: string, secret: string): Promise<string> {
  const traits = operatorIdentityTraits()
  const apps = await admin.applications.list(zoneId)
  const existing = apps.find((app: Application) => app.name === OPERATOR_APP_NAME)
  if (!existing) {
    const created = await admin.applications.create(zoneId, { name: OPERATOR_APP_NAME, registration_method: 'managed', traits })
    // Set the identity's secret to the sealed, configured value, so the running secret is
    // the platform's source of truth — supporting rotation by config change plus restart —
    // rather than the one-time secret minted at creation and never persisted.
    await admin.applications.patch(zoneId, created.id, { client_secret: secret })
    return created.id
  }
  // An existing reserved-name identity must be a usable, non-expiring managed credential; a
  // DCR or expired application with the reserved name cannot mint control tokens, so binding
  // to it would report governed execution as configured while every execution failed at the
  // token mint. Fail closed instead, so the misconfiguration surfaces rather than hiding.
  if (existing.registration_method !== 'managed' || (existing.expires_at !== null && existing.expires_at !== undefined)) {
    throw new Error('reserved operator identity exists but is not a usable non-expiring managed credential')
  }
  // Reconcile the live identity to least privilege and the configured secret. Patching the
  // secret every run keeps the running credential equal to sealed config; patching traits
  // only when drifted avoids needless writes while still self-healing a tampered identity.
  if (!sameTraitSet(existing.traits, traits)) {
    await admin.applications.patch(zoneId, existing.id, { traits })
  }
  await admin.applications.patch(zoneId, existing.id, { client_secret: secret })
  return existing.id
}

// Seals an upstream's api key into a Caracal api_key provider the gateway injects at call
// time, so the Operator never holds the key. The key's placement (header name and scheme, or a
// query parameter) is whatever the upstream expects, so any OpenAI-compatible provider works
// without per-vendor handling. When a key is supplied it is reconciled with the placement (the
// sealed secret cannot be read back, so setting or rotating re-seals). When no key is supplied
// but the placement may have changed, the existing provider's public config is patched without
// resupplying the key, so an edit applies and the sealed secret is preserved. A missing provider
// with no key returns null, marking the upstream unconfigured so no resource binds a dead
// credential. allow_runtime_injection lets the gateway inject it for a runtime exchange.
async function ensureApiKeyProvider(admin: AdminClient, zoneId: string, upstream: GovernedUpstream): Promise<string | null> {
  const identifier = llmProviderIdentifier(upstream.id)
  const providers = await admin.providers.list(zoneId)
  const existing = providers.find((provider) => provider.identifier === identifier)
  const auth = upstream.auth ?? { location: 'header', headerName: 'Authorization', authScheme: 'Bearer' }
  const placement =
    auth.location === 'query'
      ? { auth_location: 'query' as const, query_param_name: auth.queryParamName || 'api_key' }
      : {
          auth_location: 'header' as const,
          header_name: auth.headerName || 'Authorization',
          ...(auth.authScheme ? { auth_scheme: auth.authScheme } : {}),
        }
  const publicConfig = { ...placement, allow_runtime_injection: true }

  if (upstream.apiKey === undefined) {
    // No key to (re)seal: keep the sealed secret and only reconcile placement on an existing
    // provider; without one there is nothing to configure.
    if (!existing) return null
    await admin.providers.patch(zoneId, existing.id, { config_json: publicConfig })
    return existing.id
  }
  const config = { ...publicConfig, api_key: upstream.apiKey }
  if (!existing) {
    const created = await admin.providers.create(zoneId, {
      name: `Operator LLM ${upstream.id}`,
      identifier,
      kind: 'api_key',
      config_json: config,
    })
    return created.id
  }
  await admin.providers.patch(zoneId, existing.id, { kind: 'api_key', config_json: config })
  return existing.id
}

interface ResourceShape {
  upstream_url?: string | null
  scopes?: string[]
  credential_provider_id?: string | null
  gateway_application_id?: string | null
  operation_enforcement?: string
}

function sameScopeSet(live: readonly string[] | undefined, desired: readonly string[]): boolean {
  const have = new Set(live ?? [])
  return have.size === desired.length && desired.every((scope) => have.has(scope))
}

// Reconciles the governed LLM resource and its gateway binding. The resource declares the
// data scope plus agent:lifecycle (so the owner can bootstrap), binds the sealed credential
// provider, and routes through the gateway as the Operator identity. transport_uniform
// treats the upstream as one surface, so an arbitrary chat-completions path passes the
// mint-time scope check rather than a per-path operation match. Patched only on drift, so a
// steady state never bumps the gateway binding cache.
async function ensureLlmResource(
  admin: AdminClient,
  zoneId: string,
  upstream: GovernedUpstream,
  providerId: string,
  operatorAppId: string,
): Promise<string> {
  const identifier = llmResourceIdentifier(upstream.id)
  const scopes = [LLM_SCOPE, LIFECYCLE_SCOPE]
  const desired = {
    upstream_url: upstream.baseUrl,
    scopes,
    credential_provider_id: providerId,
    gateway_application_id: operatorAppId,
    operation_enforcement: 'transport_uniform' as const,
  }
  const resources = (await admin.resources.list(zoneId)) as unknown as (ResourceShape & { id: string; identifier: string })[]
  const existing = resources.find((resource) => resource.identifier === identifier)
  if (!existing) {
    await admin.resources.create(zoneId, { name: `Operator LLM ${upstream.id}`, identifier, ...desired })
    return identifier
  }
  const drifted =
    existing.upstream_url !== desired.upstream_url ||
    !sameScopeSet(existing.scopes, scopes) ||
    existing.credential_provider_id !== providerId ||
    existing.gateway_application_id !== operatorAppId ||
    existing.operation_enforcement !== desired.operation_enforcement
  if (drifted) {
    await admin.resources.patch(zoneId, existing.id, desired)
  }
  return identifier
}

// Reconciles the system zone's single data-document policy and policy-set to carry exactly
// the Operator's current grants. Policy versions are immutable, so a new version is added
// only when the authored content changes; the policy-set is re-activated only when the
// content changed or no version is active, which self-heals a deactivated set without
// churning a steady state. A zone has exactly one active policy-set, so this reuses the
// reserved-named set rather than creating a new one each run. When there are no grants and no
// system policy already exists, it creates nothing — a deployment that never governs an
// upstream gets no empty artifacts.
async function ensureOperatorPolicySet(
  admin: AdminClient,
  zoneId: string,
  operatorAppId: string,
  resourceIdentifiers: string[],
): Promise<void> {
  const policies = await admin.policies.list(zoneId)
  const policy = policies.find((entry) => entry.name === OPERATOR_POLICY_NAME)
  if (!policy && resourceIdentifiers.length === 0) return

  const content = authorOperatorPolicy(operatorAppId, resourceIdentifiers)
  const desiredSha = sha256Hex(content)

  let policyVersionId: string
  let policyChanged = false
  if (!policy) {
    const created = await admin.policies.create(zoneId, { name: OPERATOR_POLICY_NAME, content })
    policyVersionId = created.version_id
    policyChanged = true
  } else {
    const detail = await admin.policies.get(zoneId, policy.id)
    const latest = detail.versions.reduce((best, version) => (version.version > best.version ? version : best))
    if (latest.content_sha256 === desiredSha) {
      policyVersionId = latest.id
    } else {
      const added = await admin.policies.addVersion(zoneId, policy.id, content)
      policyVersionId = added.version_id
      policyChanged = true
    }
  }

  const sets = await admin.policySets.list(zoneId)
  let set = sets.find((entry) => entry.name === OPERATOR_POLICY_SET_NAME)
  if (!set) {
    set = await admin.policySets.create(zoneId, OPERATOR_POLICY_SET_NAME)
  }
  if (policyChanged || !set.active_version_id) {
    const version = await admin.policySets.addVersion(zoneId, set.id, [{ policy_version_id: policyVersionId }])
    await admin.policySets.activate(zoneId, set.id, version.version_id)
  }
}

// Archives the sealed providers for upstreams no longer configured. Pruning a removed
// upstream is a security concern, not just hygiene: a lingering sealed key stays usable and a
// lingering grant keeps authorizing the Operator to it. Archiving the provider drops the
// sealed key, and its partial-unique identifier index makes a later re-add of the same id
// clean. The grant is revoked separately by the policy-set reconcile, so the removed upstream
// loses both its authorization and its key. The LLM resource is deliberately left in place: a
// non-control resource must always carry a credential provider and gateway binding (it cannot
// be neutralized in place), and once its grant and provider are gone it is inert — no grant
// means no mandate and no gateway access. Leaving it also avoids the global-unique identifier
// conflict that archiving then re-adding would cause, and a later re-add patches it straight
// back to a fresh provider.
async function pruneOrphanedProviders(admin: AdminClient, zoneId: string, desiredProviderIdentifiers: Set<string>): Promise<void> {
  const providers = await admin.providers.list(zoneId)
  for (const provider of providers) {
    if (!provider.identifier.startsWith(LLM_PROVIDER_PREFIX) || desiredProviderIdentifiers.has(provider.identifier)) continue
    await admin.providers.delete(zoneId, provider.id)
  }
}

// Reconciles every governed upstream to a sealed provider + LLM resource + gateway binding,
// archives the providers for upstreams no longer configured, then reconciles the one
// system-zone policy-set so it grants the Operator exactly the current upstreams. An upstream
// whose provider cannot be resolved (no key supplied and none sealed before) is skipped, so it
// neither binds a dead credential nor receives a grant. Safe to run with an empty set: it
// prunes any previously governed upstream's provider and reconciles the grant set to empty.
// Returns the upstream-id to resource-identifier mapping the runtime routes through.
export async function provisionGovernedUpstreams(
  admin: AdminClient,
  zoneId: string,
  operatorAppId: string,
  upstreams: GovernedUpstream[],
): Promise<{ id: string; resourceIdentifier: string }[]> {
  const governed: { id: string; resourceIdentifier: string }[] = []
  for (const upstream of upstreams) {
    const providerId = await ensureApiKeyProvider(admin, zoneId, upstream)
    if (!providerId) continue
    const resourceIdentifier = await ensureLlmResource(admin, zoneId, upstream, providerId, operatorAppId)
    governed.push({ id: upstream.id, resourceIdentifier })
  }
  await pruneOrphanedProviders(admin, zoneId, new Set(upstreams.map((upstream) => llmProviderIdentifier(upstream.id))))
  await ensureOperatorPolicySet(
    admin,
    zoneId,
    operatorAppId,
    governed.map((entry) => entry.resourceIdentifier),
  )
  return governed
}

// Provisions the reserved caracal.sys system zone and the Operator's least-privilege
// control identity within it, idempotently. Runs as the global-scope bootstrap admin
// identity (the only actor allowed to create reserved-namespace objects), using the same
// control primitives a customer uses: a real zone, the control resource, and a real
// least-privilege control application. When governed upstreams are supplied, it also seals
// each upstream's key into Caracal and grants the Operator data-plane access through the
// gateway. Re-running converges without duplicating anything, so it is safe to call on every
// startup. The caller serializes concurrent instances so the find-then-create lookups never
// race into duplicate objects. Returns the resolved identity the Operator binds to.
export async function provisionSystemZone(
  admin: AdminClient,
  operatorSecret: string,
  audience: string,
  findZoneBySlug: FindZoneBySlug,
  governedUpstreams: GovernedUpstream[] = [],
): Promise<SystemZoneIdentity> {
  const zone = await ensureSystemZone(admin, findZoneBySlug)
  await ensureControlResource(admin, zone.id, audience)
  const operatorApplicationId = await ensureOperatorIdentity(admin, zone.id, operatorSecret)
  // Always reconcile governed upstreams, even with an empty set, so a previously governed
  // upstream that has been removed from config is pruned and its grant revoked rather than
  // left authorized with a live sealed key.
  const governedResources = await provisionGovernedUpstreams(admin, zone.id, operatorApplicationId, governedUpstreams)
  return { zoneId: zone.id, operatorApplicationId, governedResources }
}
