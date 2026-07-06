// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Server-side declarative reconciler: converges a zone toward a desired-state document with idempotent upsert, drift detection, prune, and dry-run.

import { createHash } from 'node:crypto'
import type { AdminClient } from '@caracalai/admin'
import { DispatchError } from './dispatch.js'
import type { ScopeVerb } from './commands.js'

/** Object kinds the declarative surface manages. Each maps to one catalog noun and a stable identity field. */
export type ObjectKind = 'application' | 'identity-provider' | 'resource' | 'policy' | 'policy-set'

export const OBJECT_KINDS: readonly ObjectKind[] = Object.freeze(['application', 'identity-provider', 'resource', 'policy', 'policy-set'])

/** One desired object: a kind plus the spec fields the operator wants to hold true. */
export interface DesiredObject {
  readonly kind: ObjectKind
  readonly spec: Record<string, unknown>
}

/** The published management contract: the full set an operator declares for a zone. */
export interface DesiredState {
  readonly objects: readonly DesiredObject[]
  readonly prune?: boolean
}

export type ReconcileAction = 'create' | 'update' | 'unchanged' | 'prune'

/** Per-object result. `applied` is false for dry-run/plan and for objects that failed. */
export interface ObjectOutcome {
  kind: ObjectKind
  identity: string
  action: ReconcileAction
  drift?: string[]
  id?: string
  applied: boolean
  error?: { code: string; reason: string }
}

export interface ReconcileReport {
  ok: boolean
  dryRun: boolean
  prune: boolean
  zoneId: string
  outcomes: ObjectOutcome[]
  summary: { created: number; updated: number; unchanged: number; pruned: number; failed: number }
  // True when any create/update/prune is needed: lets verify/CI gate on a single field.
  drift: boolean
}

export interface ReconcileOptions {
  readonly dryRun?: boolean
  readonly prune?: boolean
}

/** Authorizes one catalog noun + verb for the calling principal. Throws DispatchError('denied') when missing. */
export type Authorize = (command: string, verb: ScopeVerb) => void

export interface ReconcileDeps {
  readonly admin: AdminClient
  readonly authorize: Authorize
}

const SECRET_CONFIG_KEYS = new Set(['client_secret', 'private_key', 'api_key', 'bearer_token'])
const CONTROL_INVOKE_TRAIT = 'control:invoke'

// The trait namespaces reserved for the platform's own control identities. A remote control key
// that can write applications could otherwise declare `control:invoke` plus arbitrary
// `control:scope:*` traits and mint itself a wider control key - privilege escalation through
// the declarative surface. Mirrors the admin API's privileged-namespace gate.
const PRIVILEGED_TRAIT_NAMESPACES = new Set(['control', 'caracal.sys'])

interface LiveObject {
  id: string
  [key: string]: unknown
}

interface Adapter {
  readonly kind: ObjectKind
  // Catalog noun used to derive control scopes (control:<command>:<verb>).
  readonly command: string
  readonly identityField: string
  list(admin: AdminClient, zoneId: string): Promise<LiveObject[]>
  identityOf(live: LiveObject): string
  identityOfSpec(spec: Record<string, unknown>): string
  drift(admin: AdminClient, zoneId: string, live: LiveObject, spec: Record<string, unknown>): Promise<string[]>
  create(admin: AdminClient, zoneId: string, spec: Record<string, unknown>): Promise<LiveObject>
  update(admin: AdminClient, zoneId: string, live: LiveObject, spec: Record<string, unknown>, drift: string[]): Promise<LiveObject>
  protectedFromPrune(live: LiveObject): boolean
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function sameSet(left: unknown, right: unknown): boolean {
  const a = Array.isArray(left) ? left.map(String) : []
  const b = Array.isArray(right) ? right.map(String) : []
  if (a.length !== b.length) return false
  const have = new Set(a)
  return b.every((item) => have.has(item))
}

function operationKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const op = entry as { method?: unknown; path?: unknown; scope?: unknown }
    const method = String(op.method ?? '')
      .trim()
      .toUpperCase()
    const path = String(op.path ?? '').trim()
    const scope = String(op.scope ?? '')
    return `${method} ${path} ${scope}`
  })
}

function sameOperations(left: unknown, right: unknown): boolean {
  return sameSet(operationKeys(left), operationKeys(right))
}

function reqStr(spec: Record<string, unknown>, key: string, kind: string): string {
  const value = spec[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new DispatchError('invalid', `${kind} spec field "${key}" is required`, `Add a non-empty "${key}" to the ${kind} spec.`)
  }
  return value
}

function optStr(spec: Record<string, unknown>, key: string): string | undefined {
  const value = spec[key]
  return typeof value === 'string' ? value : undefined
}

function stripSecrets(config: unknown): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (SECRET_CONFIG_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function latestPolicyVersionSha(detail: LiveObject): string | undefined {
  const versions = Array.isArray(detail.versions) ? (detail.versions as Record<string, unknown>[]) : []
  let latest: Record<string, unknown> | undefined
  for (const version of versions) {
    const n = typeof version.version === 'number' ? version.version : -1
    const best = latest && typeof latest.version === 'number' ? latest.version : -1
    if (n > best) latest = version
  }
  return latest && typeof latest.content_sha256 === 'string' ? latest.content_sha256 : undefined
}

const APPLICATION_ADAPTER: Adapter = {
  kind: 'application',
  command: 'app',
  identityField: 'name',
  list: (admin, zone) => admin.applications.list(zone) as unknown as Promise<LiveObject[]>,
  identityOf: (live) => String(live.name),
  identityOfSpec: (spec) => reqStr(spec, 'name', 'application'),
  drift: async (_admin, _zone, live, spec) => {
    const drift: string[] = []
    if (Array.isArray(spec.traits) && !sameSet(live.traits, spec.traits)) drift.push('traits')
    return drift
  },
  create: (admin, zone, spec) =>
    admin.applications.create(zone, {
      name: reqStr(spec, 'name', 'application'),
      registration_method: 'managed',
      traits: Array.isArray(spec.traits) ? (spec.traits as string[]) : undefined,
    }) as unknown as Promise<LiveObject>,
  update: (admin, zone, live, spec) => {
    if (Array.isArray(live.traits) && (live.traits as string[]).includes(CONTROL_INVOKE_TRAIT)) {
      throw new DispatchError(
        'denied',
        `application "${String(live.name)}" is a control key`,
        'Manage control keys through the Console; declarative specs cannot modify them.',
      )
    }
    return admin.applications.patch(zone, live.id, {
      traits: Array.isArray(spec.traits) ? (spec.traits as string[]) : undefined,
    }) as unknown as Promise<LiveObject>
  },
  protectedFromPrune: (live) => Array.isArray(live.traits) && (live.traits as string[]).includes(CONTROL_INVOKE_TRAIT),
}

const PROVIDER_ADAPTER: Adapter = {
  kind: 'identity-provider',
  command: 'identity-provider',
  identityField: 'identifier',
  list: (admin, zone) => admin.providers.list(zone) as unknown as Promise<LiveObject[]>,
  identityOf: (live) => String(live.identifier),
  identityOfSpec: (spec) => reqStr(spec, 'identifier', 'identity-provider'),
  drift: async (_admin, _zone, live, spec) => {
    const drift: string[] = []
    if (typeof spec.name === 'string' && live.name !== spec.name) drift.push('name')
    if (typeof spec.kind === 'string' && live.kind !== spec.kind) drift.push('kind')
    if (spec.config && typeof spec.config === 'object') {
      if (canonical(stripSecrets(live.config_json)) !== canonical(stripSecrets(spec.config))) drift.push('config')
    }
    return drift
  },
  create: (admin, zone, spec) =>
    admin.providers.create(zone, {
      name: optStr(spec, 'name'),
      identifier: reqStr(spec, 'identifier', 'identity-provider'),
      kind: reqStr(spec, 'kind', 'identity-provider'),
      config_json: spec.config && typeof spec.config === 'object' ? spec.config : {},
    } as never) as unknown as Promise<LiveObject>,
  update: (admin, zone, live, spec) =>
    admin.providers.patch(zone, live.id, {
      name: optStr(spec, 'name'),
      kind: optStr(spec, 'kind'),
      config_json: spec.config && typeof spec.config === 'object' ? spec.config : undefined,
    } as never) as unknown as Promise<LiveObject>,
  protectedFromPrune: () => false,
}

const RESOURCE_ADAPTER: Adapter = {
  kind: 'resource',
  command: 'resource',
  identityField: 'identifier',
  list: (admin, zone) => admin.resources.list(zone) as unknown as Promise<LiveObject[]>,
  identityOf: (live) => String(live.identifier),
  identityOfSpec: (spec) => reqStr(spec, 'identifier', 'resource'),
  drift: async (_admin, _zone, live, spec) => {
    const drift: string[] = []
    if (typeof spec.name === 'string' && live.name !== spec.name) drift.push('name')
    if (Array.isArray(spec.scopes) && !sameSet(live.scopes, spec.scopes)) drift.push('scopes')
    if ('upstream_url' in spec && live.upstream_url !== (spec.upstream_url ?? null)) drift.push('upstream_url')
    if ('credential_provider_id' in spec && live.credential_provider_id !== (spec.credential_provider_id ?? null))
      drift.push('credential_provider_id')
    if ('operations' in spec && !sameOperations(live.operations, spec.operations)) drift.push('operations')
    if ('operation_enforcement' in spec && live.operation_enforcement !== spec.operation_enforcement) drift.push('operation_enforcement')
    return drift
  },
  create: (admin, zone, spec) =>
    admin.resources.create(zone, {
      name: optStr(spec, 'name'),
      identifier: reqStr(spec, 'identifier', 'resource'),
      scopes: Array.isArray(spec.scopes) ? (spec.scopes as string[]) : [],
      upstream_url: 'upstream_url' in spec ? (spec.upstream_url as string | null) : undefined,
      credential_provider_id: 'credential_provider_id' in spec ? (spec.credential_provider_id as string | null) : undefined,
      operations: 'operations' in spec ? (spec.operations as never) : undefined,
      operation_enforcement: 'operation_enforcement' in spec ? (spec.operation_enforcement as never) : undefined,
    } as never) as unknown as Promise<LiveObject>,
  update: (admin, zone, live, spec) =>
    admin.resources.patch(zone, live.id, {
      name: optStr(spec, 'name'),
      scopes: Array.isArray(spec.scopes) ? (spec.scopes as string[]) : undefined,
      upstream_url: 'upstream_url' in spec ? (spec.upstream_url as string | null) : undefined,
      credential_provider_id: 'credential_provider_id' in spec ? (spec.credential_provider_id as string | null) : undefined,
      operations: 'operations' in spec ? (spec.operations as never) : undefined,
      operation_enforcement: 'operation_enforcement' in spec ? (spec.operation_enforcement as never) : undefined,
    } as never) as unknown as Promise<LiveObject>,
  protectedFromPrune: () => false,
}

const POLICY_ADAPTER: Adapter = {
  kind: 'policy',
  command: 'policy',
  identityField: 'name',
  list: (admin, zone) => admin.policies.list(zone) as unknown as Promise<LiveObject[]>,
  identityOf: (live) => String(live.name),
  identityOfSpec: (spec) => reqStr(spec, 'name', 'policy'),
  drift: async (admin, zone, live, spec) => {
    const content = reqStr(spec, 'content', 'policy')
    const detail = (await admin.policies.get(zone, live.id)) as unknown as LiveObject
    return latestPolicyVersionSha(detail) === sha256Hex(content) ? [] : ['content']
  },
  create: (admin, zone, spec) =>
    admin.policies.create(zone, {
      name: reqStr(spec, 'name', 'policy'),
      description: optStr(spec, 'description'),
      content: reqStr(spec, 'content', 'policy'),
    }) as unknown as Promise<LiveObject>,
  update: (admin, zone, live, spec) =>
    admin.policies.addVersion(zone, live.id, reqStr(spec, 'content', 'policy')) as unknown as Promise<LiveObject>,
  protectedFromPrune: () => false,
}

const POLICY_SET_ADAPTER: Adapter = {
  kind: 'policy-set',
  command: 'policy-set',
  identityField: 'name',
  list: (admin, zone) => admin.policySets.list(zone) as unknown as Promise<LiveObject[]>,
  identityOf: (live) => String(live.name),
  identityOfSpec: (spec) => reqStr(spec, 'name', 'policy-set'),
  // Policy sets carry version manifests and activation that cannot be expressed as a flat
  // spec; the declarative surface only converges their existence. Version and activation
  // changes go through the explicit policy-set commands.
  drift: async () => [],
  create: (admin, zone, spec) =>
    admin.policySets.create(zone, reqStr(spec, 'name', 'policy-set'), optStr(spec, 'description')) as unknown as Promise<LiveObject>,
  update: (_admin, _zone, live) => Promise.resolve(live),
  protectedFromPrune: () => false,
}

const ADAPTERS: Record<ObjectKind, Adapter> = {
  application: APPLICATION_ADAPTER,
  'identity-provider': PROVIDER_ADAPTER,
  resource: RESOURCE_ADAPTER,
  policy: POLICY_ADAPTER,
  'policy-set': POLICY_SET_ADAPTER,
}

function adapterFor(kind: string): Adapter {
  const adapter = ADAPTERS[kind as ObjectKind]
  if (!adapter) {
    throw new DispatchError('invalid', `unknown object kind "${kind}"`, `Use one of: ${OBJECT_KINDS.join(', ')}.`)
  }
  return adapter
}

/** Parse and shape-check an untrusted desired-state document before reconciliation. */
export function parseDesiredState(raw: unknown): DesiredState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DispatchError('invalid', 'document must be a JSON object', 'Send { "objects": [ ... ], "prune": false }.')
  }
  const doc = raw as Record<string, unknown>
  if (!Array.isArray(doc.objects)) {
    throw new DispatchError('invalid', 'document field "objects" must be an array', 'Provide an "objects" array of { kind, spec } entries.')
  }
  const objects: DesiredObject[] = doc.objects.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DispatchError('invalid', `objects[${index}] must be an object`)
    }
    const item = entry as Record<string, unknown>
    if (typeof item.kind !== 'string') {
      throw new DispatchError('invalid', `objects[${index}].kind is required`, `Set kind to one of: ${OBJECT_KINDS.join(', ')}.`)
    }
    adapterFor(item.kind)
    if (!item.spec || typeof item.spec !== 'object' || Array.isArray(item.spec)) {
      throw new DispatchError('invalid', `objects[${index}].spec must be an object`)
    }
    return { kind: item.kind as ObjectKind, spec: item.spec as Record<string, unknown> }
  })
  return { objects, prune: doc.prune === true }
}

/**
 * Detect a desired-state document that targets a zone other than the one the calling
 * credential is bound to. Closes the silent cross-zone trap: a document authored for
 * zone A applied with a zone-B key fails loudly instead of provisioning the wrong zone.
 */
function assertZoneAlignment(doc: DesiredState, zoneId: string): void {
  for (const object of doc.objects) {
    const declared = object.spec.zone_id ?? object.spec.zone
    if (typeof declared === 'string' && declared !== zoneId) {
      throw new DispatchError(
        'zone_mismatch',
        `object spec targets zone "${declared}" but the credential is bound to zone "${zoneId}"`,
        'Use a control key issued for the target zone, or remove the zone field so the credential zone is used.',
      )
    }
  }
}

/** Refuse privileged trait namespaces: no declarative caller holds platform trait authority. */
function assertTraitAuthority(doc: DesiredState): void {
  for (const object of doc.objects) {
    if (object.kind !== 'application' || !Array.isArray(object.spec.traits)) continue
    for (const trait of object.spec.traits) {
      const namespace = String(trait).split(':', 1)[0]!
      if (PRIVILEGED_TRAIT_NAMESPACES.has(namespace)) {
        throw new DispatchError(
          'denied',
          `trait namespace "${namespace}" is reserved for the platform`,
          'Manage control keys through the Console; remove the reserved trait from the spec.',
        )
      }
    }
  }
}

/** Pre-authorize every catalog noun the request will touch so a missing scope fails before any write. */
function authorizeAll(doc: DesiredState, deps: ReconcileDeps, opts: ReconcileOptions): void {
  const kinds = new Set(doc.objects.map((object) => object.kind))
  for (const kind of kinds) {
    const adapter = ADAPTERS[kind]
    deps.authorize(adapter.command, 'read')
    if (!opts.dryRun) deps.authorize(adapter.command, 'write')
  }
  if (opts.prune && !opts.dryRun) {
    for (const kind of kinds) deps.authorize(ADAPTERS[kind].command, 'delete')
  }
}

/**
 * Converge a zone toward a desired-state document. Idempotent and resumable: each object is
 * looked up by its stable identity, then created, patched, or left unchanged. Operational
 * failures on one object are recorded and do not abort the rest, so a re-run heals partial
 * state. With dryRun the plan is computed without any write.
 */
export async function reconcile(
  zoneId: string,
  doc: DesiredState,
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const dryRun = opts.dryRun === true
  const prune = opts.prune === true
  assertZoneAlignment(doc, zoneId)
  assertTraitAuthority(doc)
  authorizeAll(doc, deps, opts)

  // List each declared kind once and index it by identity. Listings are independent reads, so
  // the at-most-one-per-kind calls run together; every later lookup is in-memory. This keeps a
  // large document from issuing a list call per object and from re-listing during prune.
  const kinds = [...new Set(doc.objects.map((object) => object.kind))]
  const listings = new Map<ObjectKind, LiveObject[]>()
  const listErrors = new Map<ObjectKind, unknown>()
  await Promise.all(
    kinds.map(async (kind) => {
      try {
        listings.set(kind, await ADAPTERS[kind].list(deps.admin, zoneId))
      } catch (err) {
        listErrors.set(kind, err)
      }
    }),
  )
  const index = new Map<ObjectKind, Map<string, LiveObject>>()
  for (const [kind, items] of listings) {
    const byIdentity = new Map<string, LiveObject>()
    for (const item of items) byIdentity.set(ADAPTERS[kind].identityOf(item), item)
    index.set(kind, byIdentity)
  }

  const outcomes: ObjectOutcome[] = []
  const seen = new Map<ObjectKind, Set<string>>()

  for (const object of doc.objects) {
    const adapter = ADAPTERS[object.kind]
    let identity = ''
    try {
      identity = adapter.identityOfSpec(object.spec)
      if (!seen.has(object.kind)) seen.set(object.kind, new Set())
      seen.get(object.kind)!.add(identity)
      const listError = listErrors.get(object.kind)
      if (listError) throw listError
      const live = index.get(object.kind)?.get(identity)
      if (!live) {
        if (dryRun) {
          outcomes.push({ kind: object.kind, identity, action: 'create', applied: false })
          continue
        }
        const created = await adapter.create(deps.admin, zoneId, object.spec)
        outcomes.push({ kind: object.kind, identity, action: 'create', id: created.id, applied: true })
        continue
      }
      const drift = await adapter.drift(deps.admin, zoneId, live, object.spec)
      if (drift.length === 0) {
        outcomes.push({ kind: object.kind, identity, action: 'unchanged', id: live.id, applied: true })
        continue
      }
      if (dryRun) {
        outcomes.push({ kind: object.kind, identity, action: 'update', drift, id: live.id, applied: false })
        continue
      }
      const updated = await adapter.update(deps.admin, zoneId, live, object.spec, drift)
      outcomes.push({ kind: object.kind, identity, action: 'update', drift, id: updated.id ?? live.id, applied: true })
    } catch (err) {
      outcomes.push({
        kind: object.kind,
        identity,
        action: 'unchanged',
        applied: false,
        error: { code: errorCode(err), reason: errorReason(err) },
      })
    }
  }

  if (prune) {
    for (const kind of seen.keys()) {
      const adapter = ADAPTERS[kind]
      const declared = seen.get(kind)!
      if (listErrors.has(kind)) {
        const err = listErrors.get(kind)
        outcomes.push({ kind, identity: '*', action: 'prune', applied: false, error: { code: errorCode(err), reason: errorReason(err) } })
        continue
      }
      const live = listings.get(kind) ?? []
      for (const item of live) {
        const identity = adapter.identityOf(item)
        if (declared.has(identity) || adapter.protectedFromPrune(item)) continue
        if (dryRun) {
          outcomes.push({ kind, identity, action: 'prune', id: item.id, applied: false })
          continue
        }
        try {
          await pruneOne(adapter, deps.admin, zoneId, item.id)
          outcomes.push({ kind, identity, action: 'prune', id: item.id, applied: true })
        } catch (err) {
          outcomes.push({
            kind,
            identity,
            action: 'prune',
            id: item.id,
            applied: false,
            error: { code: errorCode(err), reason: errorReason(err) },
          })
        }
      }
    }
  }

  return buildReport(zoneId, dryRun, prune, outcomes)
}

/** Converge a single object. A one-entry document; same idempotent semantics as apply. */
export async function ensure(
  zoneId: string,
  kind: string,
  spec: Record<string, unknown>,
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  adapterFor(kind)
  return reconcile(zoneId, { objects: [{ kind: kind as ObjectKind, spec }] }, deps, { dryRun: opts.dryRun })
}

async function pruneOne(adapter: Adapter, admin: AdminClient, zoneId: string, id: string): Promise<void> {
  switch (adapter.kind) {
    case 'application':
      return admin.applications.delete(zoneId, id)
    case 'identity-provider':
      return admin.providers.delete(zoneId, id)
    case 'resource':
      return admin.resources.delete(zoneId, id)
    case 'policy':
      return admin.policies.delete(zoneId, id)
    case 'policy-set':
      return admin.policySets.delete(zoneId, id)
  }
}

function buildReport(zoneId: string, dryRun: boolean, prune: boolean, outcomes: ObjectOutcome[]): ReconcileReport {
  const summary = { created: 0, updated: 0, unchanged: 0, pruned: 0, failed: 0 }
  let drift = false
  for (const outcome of outcomes) {
    if (outcome.error) summary.failed++
    if (outcome.action === 'create') {
      summary.created++
      drift = true
    } else if (outcome.action === 'update') {
      summary.updated++
      drift = true
    } else if (outcome.action === 'prune') {
      summary.pruned++
      drift = true
    } else summary.unchanged++
  }
  return { ok: summary.failed === 0, dryRun, prune, zoneId, outcomes, summary, drift }
}

function errorCode(err: unknown): string {
  if (err instanceof DispatchError) return err.code
  const status = (err as { status?: number }).status
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  return 'upstream'
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
