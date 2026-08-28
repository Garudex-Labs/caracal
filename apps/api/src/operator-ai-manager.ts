// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime manager for the Operator's governed model providers: seals keys through Caracal, reconciles the system-zone grants, and rebuilds the gateway registry so a change applies without an env edit.

import type { AdminClient } from '@caracalai/admin'
import type { Queryable } from './db.js'
import type { OperatorControlIdentity } from './config.js'
import type { ProviderConfig } from './operator-gateway.js'
import { GovernedUpstream, llmProviderIdentifier, llmResourceIdentifier, provisionGovernedUpstreams } from './system-zone.js'
import {
  deleteAiProvider,
  getAiProvider,
  insertAiProvider,
  listAiProviders,
  setAiProviderReconciliation,
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
  reconciliationState: OperatorAiProviderRecord['reconciliationState']
  reconciliationErrorCode: string | null
  credentialRequired: boolean
  reconciledAt: string | null
}

function toView(record: OperatorAiProviderRecord): OperatorAiProviderView {
  // Rows migrated from the pre-reconciliation schema have no proof that their metadata matches
  // the sealed resource. Present them as pending until restart recovery verifies that invariant.
  const reconciliationState = record.reconciliationState === 'ready' && !record.reconciledAt ? 'pending' : record.reconciliationState
  return {
    slug: record.slug,
    label: record.label,
    baseUrl: record.baseUrl,
    models: record.models,
    contextWindow: record.contextWindow,
    enabled: record.enabled,
    auth: record.auth,
    reconciliationState,
    reconciliationErrorCode: record.reconciliationErrorCode,
    credentialRequired: record.credentialRequired,
    reconciledAt: record.reconciledAt,
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

export class OperatorAiConflictError extends Error {
  constructor(slug: string) {
    super(`operator provider '${slug}' already exists`)
    this.name = 'OperatorAiConflictError'
  }
}

// Raised when reconciliation cannot safely continue without receiving the key again. This
// includes an endpoint move (the old credential must never be forwarded to a new host) and a
// missing sealed provider, which cannot be recreated from metadata because plaintext is never
// retained.
export class OperatorAiKeyRequiredError extends Error {
  constructor(slug: string) {
    super(`operator provider '${slug}' requires an api key to reconcile`)
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
    if (record.reconciliationState !== 'ready' || !record.reconciledAt) continue
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

// Which store rows a provisioning pass may seal, route, and grant, and which slugs must keep
// their sealed provider without one.
export interface StoreUpstreamPlan {
  upstreams: GovernedUpstream[]
  preservedSlugs: string[]
}

export interface StoreUpstreamOptions {
  // The slug whose lifecycle operation is driving this pass; it reconciles even though its
  // durable state is still pending.
  targetSlug?: string
  // Admits every row a restart can replay on its own, which is any row that needs no key.
  recover?: boolean
  keyOverride?: { slug: string; apiKey: string }
}

// Turns the durable rows into the desired set the provisioner converges. A row is routed and
// granted only with proof that its metadata matches its sealed resource; every other non-deleting
// row is preserved instead, keeping its credential alive for an explicit retry while
// ensureOperatorGrants revokes its authority. The boot path and every lifecycle write share this
// so the two can never classify the same row differently.
export function planStoreUpstreams(
  envUpstreams: GovernedUpstream[],
  records: OperatorAiProviderRecord[],
  options: StoreUpstreamOptions = {},
): StoreUpstreamPlan {
  const selected = records.filter((record) => {
    if (record.reconciliationState === 'deleting') return false
    if (record.reconciliationState === 'ready') return record.reconciledAt !== null
    if (record.slug === options.targetSlug) return true
    return options.recover === true && !record.credentialRequired
  })
  const selectedSlugs = new Set(selected.map((record) => record.slug))
  const preservedSlugs = records
    .filter((record) => record.reconciliationState !== 'deleting' && !selectedSlugs.has(record.slug))
    .map((record) => record.slug)
  // Every non-deleting store row shadows the env entry with the same slug, including a preserved
  // one. Otherwise this pass would seal the env key onto the very provider it is required to
  // leave untouched, and re-grant it while its durable state still says error.
  const shadowedEnvSlugs = new Set(records.filter((record) => record.reconciliationState !== 'deleting').map((record) => record.slug))
  return {
    upstreams: mergeDesiredUpstreams(
      envUpstreams.filter((upstream) => !shadowedEnvSlugs.has(upstream.id)),
      selected,
      options.keyOverride,
    ),
    preservedSlugs,
  }
}

export interface OperatorAiManager {
  available(): boolean
  list(): Promise<OperatorAiProviderView[]>
  create(input: CreateProviderInput): Promise<OperatorAiProviderView>
  update(slug: string, patch: UpdateProviderInput): Promise<OperatorAiProviderView>
  rotateKey(slug: string, apiKey: string): Promise<void>
  remove(slug: string): Promise<boolean>
  recover(): Promise<void>
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
  // Removes a provider from the live gateway before its sealed resource is touched. A failed or
  // partial reconcile therefore fails closed instead of leaving stale runtime routing enabled.
  onProviderUnavailable: (slug: string) => void
}

// Creates the manager that owns the runtime lifecycle of governed model providers. Every write
// reconciles the whole desired set through the same idempotent provisioner the boot path uses,
// then republishes the gateway registry, so the live Operator and the sealed grants stay in
// lockstep with the store.
export function createOperatorAiManager(deps: OperatorAiManagerDeps): OperatorAiManager {
  const RECONCILIATION_FAILED = 'reconciliation_failed'

  async function reconcile(options: StoreUpstreamOptions = {}): Promise<{ id: string; resourceIdentifier: string }[]> {
    const identity = deps.resolveIdentity()
    if (!identity) throw new OperatorAiUnavailableError()
    const plan = planStoreUpstreams(deps.envUpstreams, await listAiProviders(deps.db), options)
    return provisionGovernedUpstreams(deps.admin, identity.zoneId, identity.llm.applicationId, plan.upstreams, plan.preservedSlugs)
  }

  async function publish(governed: { id: string; resourceIdentifier: string }[]): Promise<void> {
    const records = await listAiProviders(deps.db)
    const resourceBySlug = new Map(governed.map((entry) => [entry.id, entry.resourceIdentifier]))
    deps.onRegistryChange(buildStoreProviderConfigs(records, resourceBySlug, deps.gatewayUrl, deps.governedFetch))
  }

  function requireGovernedTarget(governed: { id: string }[], slug: string): void {
    if (!governed.some((entry) => entry.id === slug)) throw new OperatorAiKeyRequiredError(slug)
  }

  async function markFailure(slug: string, state: 'error' | 'deleting', credentialRequired: boolean): Promise<void> {
    await setAiProviderReconciliation(deps.db, slug, state, RECONCILIATION_FAILED, credentialRequired).catch(() => {})
  }

  async function failClosed(slug: string, state: 'error' | 'deleting', credentialRequired: boolean): Promise<void> {
    await markFailure(slug, state, credentialRequired)
    // Reconcile once more without selecting the failed target. This best-effort pass revokes any
    // grant that may have been installed before a later step failed, while retaining a sealed
    // credential only when the durable row needs it for an explicit retry.
    try {
      const governed = await reconcile({})
      await publish(governed)
    } catch {
      // The durable non-ready state and the pre-reconcile registry removal remain the backstop;
      // startup recovery will retry cleanup after a process or control-plane outage.
    }
  }

  async function quarantineUnsafeUnverified(records: OperatorAiProviderRecord[]): Promise<void> {
    const identity = deps.resolveIdentity()
    if (!identity) throw new OperatorAiUnavailableError()
    const unverified = records.filter((record) => record.reconciliationState === 'ready' && !record.reconciledAt)
    if (unverified.length === 0) return

    const [providers, resources] = await Promise.all([
      deps.admin.providers.list(identity.zoneId),
      deps.admin.resources.list(identity.zoneId),
    ])
    const providerIdentifiers = new Set(providers.map((provider) => provider.identifier))
    const resourcesByIdentifier = new Map(resources.map((resource) => [resource.identifier, resource]))

    for (const record of unverified) {
      const providerExists = providerIdentifiers.has(llmProviderIdentifier(record.slug))
      const resource = resourcesByIdentifier.get(llmResourceIdentifier(record.slug))
      // A missing provider cannot be recreated without plaintext key material. A resource that
      // still names another endpoint is evidence of a pre-migration partial update; repointing it
      // would send the old sealed credential to the new host. Both cases require an explicit key.
      if (!providerExists || (resource && resource.upstream_url !== record.baseUrl)) {
        await setAiProviderReconciliation(deps.db, record.slug, 'error', RECONCILIATION_FAILED, true)
        deps.onProviderUnavailable(record.slug)
      } else {
        // Make verification progress durable before the control-plane write. If recovery fails
        // after this point, ordinary lifecycle operations still cannot select this row; only a
        // later recovery pass may finish it and stamp reconciled_at.
        await setAiProviderReconciliation(deps.db, record.slug, 'pending', null, false)
        deps.onProviderUnavailable(record.slug)
      }
    }
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
      const inserted = await insertAiProvider(deps.db, {
        slug: input.slug,
        label: input.label,
        baseUrl: input.baseUrl,
        models: input.models,
        contextWindow: input.contextWindow,
        enabled: input.enabled,
        auth: input.auth,
        reconciliationState: 'pending',
        reconciliationErrorCode: null,
        credentialRequired: true,
      })
      if (!inserted) throw new OperatorAiConflictError(input.slug)
      deps.onProviderUnavailable(input.slug)
      try {
        const governed = await reconcile({ targetSlug: input.slug, keyOverride: { slug: input.slug, apiKey: input.apiKey } })
        requireGovernedTarget(governed, input.slug)
        const record = await setAiProviderReconciliation(deps.db, input.slug, 'ready', null, false)
        if (!record) throw new OperatorAiNotFoundError(input.slug)
        await publish(governed)
        return toView(record)
      } catch (err) {
        await failClosed(input.slug, 'error', true)
        throw err
      }
    },

    async update(slug, patch) {
      if (!this.available()) throw new OperatorAiUnavailableError()
      const existing = await getAiProvider(deps.db, slug)
      // A tombstone's only valid transition is finishing its delete; editing or rotating it would
      // seal a fresh credential for an endpoint the operator already asked to destroy.
      if (!existing || existing.reconciliationState === 'deleting') throw new OperatorAiNotFoundError(slug)
      const baseUrl = patch.baseUrl ?? existing.baseUrl
      const endpointMoved = baseUrl !== existing.baseUrl
      if ((endpointMoved || existing.credentialRequired) && !patch.apiKey) throw new OperatorAiKeyRequiredError(slug)
      const credentialRequired = endpointMoved || existing.credentialRequired || patch.apiKey !== undefined
      const claimed = await upsertAiProvider(deps.db, {
        slug,
        label: patch.label ?? existing.label,
        baseUrl,
        models: patch.models ?? existing.models,
        contextWindow: patch.contextWindow ?? existing.contextWindow,
        enabled: patch.enabled ?? existing.enabled,
        auth: patch.auth ?? existing.auth,
        reconciliationState: 'pending',
        reconciliationErrorCode: null,
        credentialRequired,
      })
      // A remove that landed since the read above already tombstoned the row, and the store
      // refuses to revive it.
      if (!claimed) throw new OperatorAiNotFoundError(slug)
      deps.onProviderUnavailable(slug)
      try {
        const governed = await reconcile({
          targetSlug: slug,
          keyOverride: patch.apiKey ? { slug, apiKey: patch.apiKey } : undefined,
        })
        requireGovernedTarget(governed, slug)
        const record = await setAiProviderReconciliation(deps.db, slug, 'ready', null, false)
        if (!record) throw new OperatorAiNotFoundError(slug)
        await publish(governed)
        return toView(record)
      } catch (err) {
        await failClosed(slug, 'error', credentialRequired || err instanceof OperatorAiKeyRequiredError)
        throw err
      }
    },

    async rotateKey(slug, apiKey) {
      if (!this.available()) throw new OperatorAiUnavailableError()
      const existing = await getAiProvider(deps.db, slug)
      if (!existing || existing.reconciliationState === 'deleting') throw new OperatorAiNotFoundError(slug)
      if (!(await setAiProviderReconciliation(deps.db, slug, 'pending', null, true))) throw new OperatorAiNotFoundError(slug)
      deps.onProviderUnavailable(slug)
      try {
        const governed = await reconcile({ targetSlug: slug, keyOverride: { slug, apiKey } })
        requireGovernedTarget(governed, slug)
        await setAiProviderReconciliation(deps.db, slug, 'ready', null, false)
        await publish(governed)
      } catch (err) {
        await failClosed(slug, 'error', true)
        throw err
      }
    },

    async remove(slug) {
      if (!this.available()) throw new OperatorAiUnavailableError()
      const existing = await getAiProvider(deps.db, slug)
      if (existing) await setAiProviderReconciliation(deps.db, slug, 'deleting', null, false)
      deps.onProviderUnavailable(slug)
      try {
        const governed = await reconcile({ targetSlug: slug })
        if (existing) await deleteAiProvider(deps.db, slug)
        await publish(governed)
        return existing !== null
      } catch (err) {
        if (existing) await failClosed(slug, 'deleting', false)
        throw err
      }
    },

    async recover() {
      if (!this.available()) throw new OperatorAiUnavailableError()
      const records = await listAiProviders(deps.db)
      // This runs on every rotation tick, not only at boot, so that a row left behind by a failed
      // write still converges on its own. A fully reconciled store has nothing to replay, and
      // repeating the pass would re-seal every upstream to reach the state it is already in.
      if (records.every((record) => record.reconciliationState === 'ready' && record.reconciledAt !== null)) return
      await quarantineUnsafeUnverified(records)
      const before = await listAiProviders(deps.db)
      for (const record of before) {
        if (record.reconciliationState !== 'ready' || !record.reconciledAt) deps.onProviderUnavailable(record.slug)
      }
      const governed = await reconcile({ recover: true })
      const governedSlugs = new Set(governed.map((entry) => entry.id))
      for (const record of before) {
        if (record.reconciliationState === 'deleting') {
          await deleteAiProvider(deps.db, record.slug)
        } else if (record.reconciliationState === 'ready' || !record.credentialRequired) {
          if (governedSlugs.has(record.slug)) {
            await setAiProviderReconciliation(deps.db, record.slug, 'ready', null, false)
          } else {
            // This covers rows created before durable lifecycle state existed: if the sealed
            // provider is absent, startup cannot recreate it without a key. Mark it visibly inert
            // instead of continuing to present migrated metadata as ready.
            await setAiProviderReconciliation(deps.db, record.slug, 'error', RECONCILIATION_FAILED, true)
            deps.onProviderUnavailable(record.slug)
          }
        }
      }
      await publish(governed)
    },
  }
}
