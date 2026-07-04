// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Idempotent provisioner for the reserved caracal.sys system zone the Operator self-governs through the control plane.

import { randomBytes } from 'node:crypto'
import { ensureApiKeyProvider, ensureApplication, ensureGrants, ensureResource, type AdminClient } from '@caracalai/admin'
import { ensureControlResource } from '@caracalai/engine'
import type { OperatorControlCredential } from './config.js'

// The reserved system zone, encoded per the caracal.sys namespace standard: a slug in the
// caracal-sys- form and a name in the caracal.sys/ form. Both are reserved, so only a
// global-scope platform actor may create them - exactly the bootstrap admin identity the
// provisioner runs as.
export const SYSTEM_ZONE_SLUG = 'caracal-sys-internal'
export const SYSTEM_ZONE_NAME = 'caracal.sys/system'

// The Operator's reserved identities inside the system zone, named in the reserved
// caracal.sys/ form so a tenant can never create or impersonate them. Each agent permission
// boundary is its own application: the base identity owns the governed LLM resources on the
// data plane and holds no control authority at all, while the researcher and executor are
// distinct control identities whose STS traits bound exactly what each can mint.
export const OPERATOR_APP_NAME = 'caracal.sys/operator'
export const RESEARCHER_APP_NAME = 'caracal.sys/operator-researcher'
export const EXECUTOR_APP_NAME = 'caracal.sys/operator-executor'

const CONTROL_INVOKE_TRAIT = 'control:invoke'
const CONTROL_SCOPE_TRAIT_PREFIX = 'control:scope:'
const CONTROL_MAX_TTL_TRAIT_PREFIX = 'control:max-ttl:'
const CONTROL_EXPIRES_TRAIT_PREFIX = 'control:expires:'

// Credential lifecycle: every secret is generated in process, sealed into its application,
// and held in memory only - no environment or persisted credential exists. The STS enforces
// the deadline through the control:expires trait, so a credential that misses its rotation
// stops minting at the STS itself, not just in this process. Rotation re-provisions with
// fresh secrets and a new deadline well before expiry.
export const OPERATOR_CREDENTIAL_TTL_SEC = 3600
export const OPERATOR_CREDENTIAL_ROTATE_SEC = 2700
// Caps every minted control token's lifetime at the STS regardless of the requested ttl.
export const CONTROL_TOKEN_MAX_TTL_SEC = 300

// The least-privilege control scope sets for the role identities, derived by the caller
// from the capability catalog and the Operator's granted authority.
export interface OperatorRoleScopes {
  researcher: string[]
  executor: string[]
}

// The canonical trait set for one control role identity: control:invoke, the token-lifetime
// cap, the credential deadline, and one control:scope: trait per role scope. The provisioner
// reconciles the live identity to exactly this set on every run, so a hand-narrowed or
// widened identity self-heals to least privilege.
export function roleIdentityTraits(scopes: string[], expiresAt: Date): string[] {
  return [
    CONTROL_INVOKE_TRAIT,
    `${CONTROL_MAX_TTL_TRAIT_PREFIX}${CONTROL_TOKEN_MAX_TTL_SEC}`,
    `${CONTROL_EXPIRES_TRAIT_PREFIX}${expiresAt.toISOString()}`,
    ...[...scopes].sort().map((scope) => `${CONTROL_SCOPE_TRAIT_PREFIX}${scope}`),
  ]
}

// The resolved system-zone identities the Operator executes as: the system zone, one
// credential per permission boundary, and the fail-closed deadline after which every
// credential must be treated as unconfigured. Secrets are in-memory only and never returned
// through any API surface. governedResources maps each governed upstream's id to the Caracal
// resource identifier the Operator routes its calls through.
export interface SystemZoneIdentity {
  zoneId: string
  llm: OperatorControlCredential
  researcher: OperatorControlCredential
  executor: OperatorControlCredential
  expiresAt: Date
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
// The role label the Operator's governed transports spawn with and its grants authorize,
// so the sessions minting on governed resources attribute to the Operator by name.
export const OPERATOR_ROLE = 'operator'
export const LLM_SCOPE = 'llm:invoke'

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

// Resolves the id of a zone by its exact slug, or null when no such zone exists. A
// deterministic lookup the provisioner depends on instead of scanning a page of the zone
// list: the system zone is created at first boot (the oldest zone), so in a deployment with
// more than one page of zones it would fall off the newest-first first page and a list scan
// would miss it - then try to create it and conflict on the unique slug. Looking it up by
// slug finds it regardless of zone count or archival, so provisioning stays convergent.
export type FindZoneBySlug = (slug: string) => Promise<{ id: string } | null>

async function ensureSystemZone(admin: AdminClient, findZoneBySlug: FindZoneBySlug): Promise<{ id: string }> {
  const existing = await findZoneBySlug(SYSTEM_ZONE_SLUG)
  if (existing) return existing
  return admin.zones.create({ name: SYSTEM_ZONE_NAME, slug: SYSTEM_ZONE_SLUG })
}

// Generates a fresh high-entropy client secret in the format the applications route issues.
// Secrets exist only in process memory: generated here, sealed into the application, and
// replaced wholesale on every rotation, so a captured secret has a bounded useful life and
// no environment or file ever carries one.
function generateClientSecret(): string {
  return `cs_${randomBytes(32).toString('base64url')}`
}

// Converges one reserved role identity: created managed with its canonical trait set, or
// reconciled to least privilege when it already exists. The trait set carries the credential
// deadline, so a rotation always advances it; the secret seal on every run is the rotation
// itself - the previous secret stops working the moment the new one is sealed, which is also
// how a compromised credential is revoked. An unusable reserved-name identity (DCR or
// app-expiring) fails the provisioning run closed rather than binding a dead credential.
function ensureRoleIdentity(admin: AdminClient, zoneId: string, name: string, traits: string[], secret: string): Promise<string> {
  return ensureApplication(admin, zoneId, { name, traits, clientSecret: secret })
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
function ensureLlmProvider(admin: AdminClient, zoneId: string, upstream: GovernedUpstream): Promise<string | null> {
  const auth = upstream.auth ?? { location: 'header', headerName: 'Authorization', authScheme: 'Bearer' }
  const placement =
    auth.location === 'query'
      ? { auth_location: 'query' as const, query_param_name: auth.queryParamName || 'api_key' }
      : {
          auth_location: 'header' as const,
          header_name: auth.headerName || 'Authorization',
          ...(auth.authScheme ? { auth_scheme: auth.authScheme } : {}),
        }
  return ensureApiKeyProvider(admin, zoneId, {
    name: `Operator LLM ${upstream.id}`,
    identifier: llmProviderIdentifier(upstream.id),
    publicConfig: { ...placement, allow_runtime_injection: true },
    apiKey: upstream.apiKey,
  })
}

// Reconciles the governed LLM resource and its gateway binding. The resource declares the
// data scope (the reconciler adds the owner's bootstrap scope to every gateway-bound
// resource), binds the sealed credential provider, and routes through the gateway as the
// Operator identity. transport_uniform treats the upstream as one surface, so an arbitrary
// chat-completions path passes the mint-time scope check rather than a per-path operation
// match. Patched only on drift, so a steady state never bumps the gateway binding cache.
async function ensureLlmResource(
  admin: AdminClient,
  zoneId: string,
  upstream: GovernedUpstream,
  providerId: string,
  operatorAppId: string,
): Promise<string> {
  const identifier = llmResourceIdentifier(upstream.id)
  await ensureResource(admin, zoneId, {
    name: `Operator LLM ${upstream.id}`,
    identifier,
    scopes: [LLM_SCOPE],
    upstream_url: upstream.baseUrl,
    credential_provider_id: providerId,
    gateway_application_id: operatorAppId,
    operation_enforcement: 'transport_uniform',
  })
  return identifier
}

// Reconciles the system zone's grant policy to exactly the Operator's current governed
// resources: the base identity may mint the LLM scope on each, under the operator role its
// transports spawn with. When there are no grants and no system policy already exists, it
// creates nothing - a deployment that never governs an upstream gets no empty artifacts.
function ensureOperatorGrants(admin: AdminClient, zoneId: string, operatorAppId: string, resourceIdentifiers: string[]): Promise<void> {
  return ensureGrants(admin, zoneId, {
    policyName: OPERATOR_POLICY_NAME,
    setName: OPERATOR_POLICY_SET_NAME,
    grants: resourceIdentifiers.map((resourceIdentifier) => ({
      applicationId: operatorAppId,
      resourceIdentifier,
      scopes: [LLM_SCOPE],
      role: OPERATOR_ROLE,
    })),
  })
}

// Archives the sealed providers for upstreams no longer configured. Pruning a removed
// upstream is a security concern, not just hygiene: a lingering sealed key stays usable and a
// lingering grant keeps authorizing the Operator to it. Archiving the provider drops the
// sealed key, and its partial-unique identifier index makes a later re-add of the same id
// clean. The grant is revoked separately by the policy-set reconcile, so the removed upstream
// loses both its authorization and its key. The LLM resource is deliberately left in place: a
// non-control resource must always carry a credential provider and gateway binding (it cannot
// be neutralized in place), and once its grant and provider are gone it is inert - no grant
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
    const providerId = await ensureLlmProvider(admin, zoneId, upstream)
    if (!providerId) continue
    const resourceIdentifier = await ensureLlmResource(admin, zoneId, upstream, providerId, operatorAppId)
    governed.push({ id: upstream.id, resourceIdentifier })
  }
  await pruneOrphanedProviders(admin, zoneId, new Set(upstreams.map((upstream) => llmProviderIdentifier(upstream.id))))
  await ensureOperatorGrants(
    admin,
    zoneId,
    operatorAppId,
    governed.map((entry) => entry.resourceIdentifier),
  )
  return governed
}

// Provisions the reserved caracal.sys system zone and the Operator's least-privilege
// identities within it, idempotently. Runs as the global-scope bootstrap admin identity
// (the only actor allowed to create reserved-namespace objects), using the same control
// primitives a customer uses: a real zone, the control resource, and real least-privilege
// control applications - one per agent permission boundary, so the STS can only ever mint
// what each role's own traits grant. Every call generates fresh secrets and a fresh
// credential deadline, so re-running is also the rotation path; it converges without
// duplicating anything and is safe to call on every startup and every rotation tick. When
// governed upstreams are supplied, it also seals each upstream's key into Caracal and grants
// the base identity data-plane access through the gateway. The caller serializes concurrent
// instances so the find-then-create lookups never race into duplicate objects. Returns the
// resolved identities the Operator binds to.
export async function provisionSystemZone(
  admin: AdminClient,
  audience: string,
  findZoneBySlug: FindZoneBySlug,
  roles: OperatorRoleScopes,
  governedUpstreams: GovernedUpstream[] = [],
): Promise<SystemZoneIdentity> {
  const zone = await ensureSystemZone(admin, findZoneBySlug)
  await ensureControlResource(admin, zone.id, audience)
  const expiresAt = new Date(Date.now() + OPERATOR_CREDENTIAL_TTL_SEC * 1000)
  const llmSecret = generateClientSecret()
  const researcherSecret = generateClientSecret()
  const executorSecret = generateClientSecret()
  // The base identity holds no control traits at all: it exists only to own the governed
  // LLM resources on the data plane, so it can never invoke the control plane.
  const llmId = await ensureRoleIdentity(admin, zone.id, OPERATOR_APP_NAME, [], llmSecret)
  const researcherId = await ensureRoleIdentity(
    admin,
    zone.id,
    RESEARCHER_APP_NAME,
    roleIdentityTraits(roles.researcher, expiresAt),
    researcherSecret,
  )
  const executorId = await ensureRoleIdentity(
    admin,
    zone.id,
    EXECUTOR_APP_NAME,
    roleIdentityTraits(roles.executor, expiresAt),
    executorSecret,
  )
  // Always reconcile governed upstreams, even with an empty set, so a previously governed
  // upstream that has been removed from config is pruned and its grant revoked rather than
  // left authorized with a live sealed key.
  const governedResources = await provisionGovernedUpstreams(admin, zone.id, llmId, governedUpstreams)
  return {
    zoneId: zone.id,
    llm: { applicationId: llmId, clientSecret: llmSecret },
    researcher: { applicationId: researcherId, clientSecret: researcherSecret },
    executor: { applicationId: executorId, clientSecret: executorSecret },
    expiresAt,
    governedResources,
  }
}
