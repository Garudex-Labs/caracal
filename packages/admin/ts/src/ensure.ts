// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Idempotent reconcilers that converge applications, providers, resources, and policy sets to a desired state.

import type { AdminClient } from './client.js'
import type { APIKeyProviderConfig, ProviderIdentifier, Resource, ResourceInput, ResourceOperationEnforcement } from './types.js'

function sameStringSet(live: readonly string[] | undefined, desired: readonly string[]): boolean {
  const have = new Set(live ?? [])
  return have.size === desired.length && desired.every((value) => have.has(value))
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface EnsureApplicationInput {
  name: string
  traits: string[]
  clientSecret: string
}

// Converges a managed application to exactly the given trait set and seals the given
// client secret, creating it when absent. The secret patch on every run is the rotation
// itself: the previous secret stops working the moment the new one is sealed, which is
// also how a compromised credential is revoked. An existing same-named identity must be a
// usable managed credential; a DCR or app-expiring application cannot carry a rotating
// secret, so binding to it would report the identity configured while every token mint
// failed. Fail closed instead, so the misconfiguration surfaces rather than hiding.
// Returns the application id.
export async function ensureApplication(client: AdminClient, zoneId: string, input: EnsureApplicationInput): Promise<string> {
  const apps = await client.applications.list(zoneId)
  const existing = apps.find((app) => app.name === input.name)
  if (!existing) {
    const created = await client.applications.create(zoneId, { name: input.name, registration_method: 'managed', traits: input.traits })
    // Seal the caller's secret so the one-time secret minted at creation is never the
    // running credential.
    await client.applications.patch(zoneId, created.id, { client_secret: input.clientSecret })
    return created.id
  }
  if (existing.registration_method !== 'managed' || (existing.expires_at !== null && existing.expires_at !== undefined)) {
    throw new Error(`application ${input.name} exists but is not a usable managed credential`)
  }
  if (!sameStringSet(existing.traits, input.traits)) {
    await client.applications.patch(zoneId, existing.id, { traits: input.traits })
  }
  await client.applications.patch(zoneId, existing.id, { client_secret: input.clientSecret })
  return existing.id
}

export interface EnsureApiKeyProviderInput {
  name: string
  identifier: ProviderIdentifier
  publicConfig: APIKeyProviderConfig
  apiKey?: string
}

// Seals an api key into an api_key provider the gateway injects at call time, so the
// caller never holds the key. When a key is supplied it is reconciled together with the
// public placement config (the sealed secret cannot be read back, so setting or rotating
// re-seals). When no key is supplied but the placement may have changed, the existing
// provider's public config is patched without resupplying the key, so an edit applies and
// the sealed secret is preserved. A missing provider with no key returns null, marking the
// credential unconfigured so no resource binds a dead credential.
export async function ensureApiKeyProvider(client: AdminClient, zoneId: string, input: EnsureApiKeyProviderInput): Promise<string | null> {
  const providers = await client.providers.list(zoneId)
  const existing = providers.find((provider) => provider.identifier === input.identifier)
  if (input.apiKey === undefined) {
    if (!existing) return null
    await client.providers.patch(zoneId, existing.id, { config_json: input.publicConfig })
    return existing.id
  }
  const config = { ...input.publicConfig, api_key: input.apiKey }
  if (!existing) {
    const created = await client.providers.create(zoneId, {
      name: input.name,
      identifier: input.identifier,
      kind: 'api_key',
      config_json: config,
    })
    return created.id
  }
  await client.providers.patch(zoneId, existing.id, { kind: 'api_key', config_json: config })
  return existing.id
}

export interface EnsureResourceInput {
  name: string
  identifier: string
  scopes: string[]
  upstream_url?: string | null
  credential_provider_id?: string | null
  gateway_application_id?: string | null
  operation_enforcement?: ResourceOperationEnforcement
}

// Converges a resource to the given desired fields, creating it when absent and patching
// it only on drift so a steady state never bumps caches keyed on the resource row. Fields
// left undefined are not managed: they are excluded from both the drift comparison and the
// patch, so a reconciler that owns only some fields never clobbers the rest. Returns the
// live resource.
export async function ensureResource(client: AdminClient, zoneId: string, input: EnsureResourceInput): Promise<Resource> {
  const desired: Partial<ResourceInput> = { scopes: input.scopes }
  if (input.upstream_url !== undefined) desired.upstream_url = input.upstream_url
  if (input.credential_provider_id !== undefined) desired.credential_provider_id = input.credential_provider_id
  if (input.gateway_application_id !== undefined) desired.gateway_application_id = input.gateway_application_id
  if (input.operation_enforcement !== undefined) desired.operation_enforcement = input.operation_enforcement
  const resources = await client.resources.list(zoneId)
  const existing = resources.find((resource) => resource.identifier === input.identifier)
  if (!existing) {
    return client.resources.create(zoneId, { name: input.name, identifier: input.identifier, ...desired, scopes: input.scopes })
  }
  const drifted =
    !sameStringSet(existing.scopes, input.scopes) ||
    (desired.upstream_url !== undefined && existing.upstream_url !== desired.upstream_url) ||
    (desired.credential_provider_id !== undefined && existing.credential_provider_id !== desired.credential_provider_id) ||
    (desired.gateway_application_id !== undefined && existing.gateway_application_id !== desired.gateway_application_id) ||
    (desired.operation_enforcement !== undefined && existing.operation_enforcement !== desired.operation_enforcement)
  if (!drifted) return existing
  return client.resources.patch(zoneId, existing.id, desired)
}

export interface EnsureActivePolicySetInput {
  policyName: string
  setName: string
  content: string
  // When false and no policy with policyName exists yet, nothing is created: an empty
  // desired state materializes no artifacts. Defaults to true.
  createWhenMissing?: boolean
}

// Converges one named policy and policy set to carry exactly the given content, active.
// Policy versions are immutable, so a new version is added only when the content's digest
// changes; the set is re-activated only when the content changed or no version is active,
// which self-heals a deactivated set without churning a steady state.
export async function ensureActivePolicySet(client: AdminClient, zoneId: string, input: EnsureActivePolicySetInput): Promise<void> {
  const policies = await client.policies.list(zoneId)
  const policy = policies.find((entry) => entry.name === input.policyName)
  if (!policy && input.createWhenMissing === false) return

  const desiredSha = await sha256Hex(input.content)
  let policyVersionId: string
  let policyChanged = false
  if (!policy) {
    const created = await client.policies.create(zoneId, { name: input.policyName, content: input.content })
    policyVersionId = created.version_id
    policyChanged = true
  } else {
    const detail = await client.policies.get(zoneId, policy.id)
    const latest = detail.versions.reduce((best, version) => (version.version > best.version ? version : best))
    if (latest.content_sha256 === desiredSha) {
      policyVersionId = latest.id
    } else {
      const added = await client.policies.addVersion(zoneId, policy.id, input.content)
      policyVersionId = added.version_id
      policyChanged = true
    }
  }

  const sets = await client.policySets.list(zoneId)
  let set = sets.find((entry) => entry.name === input.setName)
  if (!set) {
    set = await client.policySets.create(zoneId, input.setName)
  }
  if (policyChanged || !set.active_version_id) {
    const version = await client.policySets.addVersion(zoneId, set.id, [{ policy_version_id: policyVersionId }])
    await client.policySets.activate(zoneId, set.id, version.version_id)
  }
}
