// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime manager for the Operator's governed model providers: seals keys through Caracal, reconciles the system-zone grants, and rebuilds the gateway registry so a change applies without an env edit.

import type { AdminClient } from '@caracalai/admin'
import type { Queryable } from './db.js'
import type { OperatorControlIdentity } from './config.js'
import type { ProviderConfig } from './operator-gateway.js'
import { GovernedUpstream, provisionGovernedUpstreams } from './system-zone.js'
import {
  deleteAiProvider,
  getAiProvider,
  listAiProviders,
  upsertAiProvider,
  type AuthPlacement,
  type OperatorAiProviderRecord,
} from './operator-ai-store.js'

const DEFAULT_TIMEOUT_MS = 30_000

// The client-facing view of a configured provider. It is the stored metadata only: the key is
// never represented here because it lives sealed in the Caracal provider, not in the registry.
export interface OperatorAiProviderView {
  slug: string
  label: string
  baseUrl: string
  models: string[]
  contextWindow: number
  enabled: boolean
  auth: AuthPlacement
}

function toView(record: OperatorAiProviderRecord): OperatorAiProviderView {
  return {
    slug: record.slug,
    label: record.label,
    baseUrl: record.baseUrl,
    models: record.models,
    contextWindow: record.contextWindow,
    enabled: record.enabled,
    auth: record.auth,
  }
}

export interface CreateProviderInput {
  slug: string
  label: string
  baseUrl: string
  models: string[]
  contextWindow: number
  apiKey: string
  enabled: boolean
  auth: AuthPlacement
}

export interface UpdateProviderInput {
  label?: string
  baseUrl?: string
  models?: string[]
  contextWindow?: number
  enabled?: boolean
  auth?: AuthPlacement
  // Required when baseUrl changes, so the endpoint and the credential it receives always move
  // together. Omitted on every other update, which reconciles without re-sealing.
  apiKey?: string
}

// Raised when a write is attempted while governed execution is not configured. The routes map
// it to a 409 so the console can explain that self-governance must be enabled before a key can
// be sealed; a write never falls back to holding the key unsealed.
export class OperatorAiUnavailableError extends Error {
  constructor() {
    super('operator governed execution is not configured')
    this.name = 'OperatorAiUnavailableError'
  }
}

export class OperatorAiNotFoundError extends Error {
  constructor(slug: string) {
    super(`operator provider '${slug}' not found`)
    this.name = 'OperatorAiNotFoundError'
  }
}

// Raised when an update moves a provider's endpoint without supplying the key to seal for it.
// The sealed key is bound to the provider slug rather than the URL, so reconciling a changed
// baseUrl without a new key would re-point the existing credential at the new endpoint and hand
// it to whoever operates that host on the next call. Requiring the key makes the two move as one
// operation, and the old credential is replaced rather than forwarded.
export class OperatorAiKeyRequiredError extends Error {
  constructor(slug: string) {
    super(`operator provider '${slug}' requires a new api key when its base url changes`)
    this.name = 'OperatorAiKeyRequiredError'
  }
}

// A gateway provider id is one selectable entry. A provider serving a single model uses its
// slug directly; one serving several gives each model its own id so failover and selection can
// address them independently, while they share the slug's sealed key and resource.
export function providerConfigId(slug: string, model: string, multiModel: boolean): string {
  if (!multiModel) return slug
  const modelSlug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${slug}__${modelSlug}`
}

// Builds the gateway entries for the store-managed providers. Each enabled provider that
// resolved to a governed resource contributes one entry per model, all routed through the
// gateway with the provider's minted-mandate transport, so the Operator reaches the model
// without holding the key. A provider with no resolved resource (its key was never sealed) is
// skipped rather than offered as a dead entry.
export function buildStoreProviderConfigs(
  records: OperatorAiProviderRecord[],
  resourceBySlug: Map<string, string>,
  gatewayUrl: string,
  governedFetch: (resourceIdentifier: string) => typeof fetch,
): ProviderConfig[] {
  const configs: ProviderConfig[] = []
  for (const record of records) {
    if (!record.enabled) continue
    const resourceIdentifier = resourceBySlug.get(record.slug)
    if (!resourceIdentifier) continue
    const multiModel = record.models.length > 1
    for (const model of record.models) {
      configs.push({
        id: providerConfigId(record.slug, model, multiModel),
        baseUrl: gatewayUrl,
        model,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        contextWindow: record.contextWindow,
        transport: governedFetch(resourceIdentifier),
      })
    }
  }
  return configs
}

// Merges the env-configured upstreams with the store-managed ones into the single desired set
// the reconciler prunes against, so neither source erases the other's sealed providers. Env
// upstreams always carry their key (re-sealed each run); store upstreams carry a key only for
// the one slug being set or rotated, and otherwise reconcile by identifier without re-sealing.
// A store slug shadows an env slug so a UI-managed provider always wins.
export function mergeDesiredUpstreams(
  envUpstreams: GovernedUpstream[],
  records: OperatorAiProviderRecord[],
  keyOverride?: { slug: string; apiKey: string },
): GovernedUpstream[] {
  const bySlug = new Map<string, GovernedUpstream>()
  for (const upstream of envUpstreams) bySlug.set(upstream.id, upstream)
  for (const record of records) {
    const apiKey = keyOverride && keyOverride.slug === record.slug ? keyOverride.apiKey : undefined
    // The governed resource points at the OpenAI-compatible endpoint the operator entered; the
    // gateway injects the sealed key at call time with the record's placement.
    bySlug.set(record.slug, { id: record.slug, baseUrl: record.baseUrl, apiKey, auth: record.auth })
  }
  return [...bySlug.values()]
}

export interface OperatorAiManager {
  available(): boolean
  list(): Promise<OperatorAiProviderView[]>
  create(input: CreateProviderInput): Promise<OperatorAiProviderView>
  update(slug: string, patch: UpdateProviderInput): Promise<OperatorAiProviderView>
  rotateKey(slug: string, apiKey: string): Promise<void>
  remove(slug: string): Promise<boolean>
}

export interface OperatorAiManagerDeps {
  db: Queryable
  admin: AdminClient
  // The Operator's resolved control identity, or null until the system zone is provisioned or
  // when self-governance is disabled. A write requires it because sealing a key runs as this
  // identity through the control plane.
  resolveIdentity: () => OperatorControlIdentity | null
  envUpstreams: GovernedUpstream[]
  gatewayUrl: string
  // Builds the governed transport for one resource: the SDK client's minted-mandate fetch,
  // bound to the Operator identity the credentials resolver supplies.
  governedFetch: (resourceIdentifier: string) => typeof fetch
  // Publishes the rebuilt store-provider gateway entries so the next request's gateway includes
  // the change without an env edit or restart.
  onRegistryChange: (configs: ProviderConfig[]) => void
  // Publishes a cross-replica invalidation only after a metadata mutation and its control-plane
  // reconciliation both succeed. Key rotation changes the shared sealed credential, not this
  // metadata registry, and deliberately does not invoke this callback.
  onRegistryMutation: () => Promise<void>
}

// Creates the manager that owns the runtime lifecycle of governed model providers. Every write
// reconciles the whole desired set through the same idempotent provisioner the boot path uses,
// then republishes the gateway registry, so the live Operator and the sealed grants stay in
// lockstep with the store.
export function createOperatorAiManager(deps: OperatorAiManagerDeps): OperatorAiManager {
  async function reconcile(keyOverride?: { slug: string; apiKey: string }): Promise<void> {
    const identity = deps.resolveIdentity()
    if (!identity) throw new OperatorAiUnavailableError()
    const records = await listAiProviders(deps.db)
    const upstreams = mergeDesiredUpstreams(deps.envUpstreams, records, keyOverride)
    const governed = await provisionGovernedUpstreams(deps.admin, identity.zoneId, identity.llm.applicationId, upstreams)
    const resourceBySlug = new Map(governed.map((entry) => [entry.id, entry.resourceIdentifier]))
    deps.onRegistryChange(buildStoreProviderConfigs(records, resourceBySlug, deps.gatewayUrl, deps.governedFetch))
  }

  return {
    available() {
      return deps.resolveIdentity() !== null
    },

    async list() {
      const records = await listAiProviders(deps.db)
      return records.map(toView)
    },

    async create(input) {
      if (!this.available()) throw new OperatorAiUnavailableError()
      const record = await upsertAiProvider(deps.db, {
        slug: input.slug,
        label: input.label,
        baseUrl: input.baseUrl,
        models: input.models,
        contextWindow: input.contextWindow,
        enabled: input.enabled,
        auth: input.auth,
      })
      await reconcile({ slug: input.slug, apiKey: input.apiKey })
      await deps.onRegistryMutation()
      return toView(record)
    },

    async update(slug, patch) {
      if (!this.available()) throw new OperatorAiUnavailableError()
      const existing = await getAiProvider(deps.db, slug)
      if (!existing) throw new OperatorAiNotFoundError(slug)
      const baseUrl = patch.baseUrl ?? existing.baseUrl
      const endpointMoved = baseUrl !== existing.baseUrl
      if (endpointMoved && !patch.apiKey) throw new OperatorAiKeyRequiredError(slug)
      const record = await upsertAiProvider(deps.db, {
        slug,
        label: patch.label ?? existing.label,
        baseUrl,
        models: patch.models ?? existing.models,
        contextWindow: patch.contextWindow ?? existing.contextWindow,
        enabled: patch.enabled ?? existing.enabled,
        auth: patch.auth ?? existing.auth,
      })
      const metadataChanged =
        patch.label !== undefined ||
        patch.baseUrl !== undefined ||
        patch.models !== undefined ||
        patch.contextWindow !== undefined ||
        patch.enabled !== undefined ||
        patch.auth !== undefined
      await reconcile(patch.apiKey ? { slug, apiKey: patch.apiKey } : undefined)
      if (metadataChanged) await deps.onRegistryMutation()
      return toView(record)
    },

    async rotateKey(slug, apiKey) {
      if (!this.available()) throw new OperatorAiUnavailableError()
      const existing = await getAiProvider(deps.db, slug)
      if (!existing) throw new OperatorAiNotFoundError(slug)
      await reconcile({ slug, apiKey })
    },

    async remove(slug) {
      if (!this.available()) throw new OperatorAiUnavailableError()
      const removed = await deleteAiProvider(deps.db, slug)
      if (removed) {
        await reconcile()
        await deps.onRegistryMutation()
      }
      return removed
    },
  }
}
