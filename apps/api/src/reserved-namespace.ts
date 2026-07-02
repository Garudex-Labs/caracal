// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Server-side reservation of the Caracal-internal object namespace so tenants cannot create or impersonate platform-internal identities.

import type { Actor } from './auth.js'

// The reserved identifiers that anchor the Console URL hierarchy /:accountId/:orgId/:zoneId/app.
// Open source has no orgs, so every account's standalone zones sit under one sentinel org; the
// system zone sits under Caracal's own org, identical for every account and edition. These ids
// are reserved: a tenant zone must never be minted with the system zone id, so the generator
// regenerates on the astronomically unlikely collision rather than shadowing the reserved zone.
export const OSS_ORG_ID = 'ORG-0000-0000-0000'
export const CARACAL_ORG_ID = 'ORG-CRC0-SYS0-0001'

// Resolves the org an open-source request acts under. Open source has no concept of orgs or teams,
// so there is exactly one valid org: the sentinel. Caracal's own system org is accepted as-is so
// the reserved system zone resolves; every other value is collapsed to the sentinel rather than
// honoured, so a tampered org id in the URL or a request body can never address a non-existent org
// — it simply lands back on the single open-source org. Org creation lives only in the enterprise
// build, so without it no other org can exist; this keeps the open-source build correct even if the
// guard is bypassed. Enterprise overrides org resolution with its real, validated org directory.
export function resolveOssOrg(orgId: string | undefined): string {
  return orgId === CARACAL_ORG_ID ? CARACAL_ORG_ID : OSS_ORG_ID
}

// The set of zone ids no tenant zone may take. The system zone is provisioned with a fixed,
// reserved id so its URL is the same for everyone; everything else is generated. A generated id
// landing on a reserved value is regenerated, so the reserved space is never silently occupied.
export const RESERVED_ZONE_IDS = new Set<string>([OSS_ORG_ID])

// Mints a zone id that is never one of the reserved sentinels. Tenant zones are generated, so on
// the astronomically unlikely collision it regenerates rather than shadowing a reserved zone.
export function mintZoneId(generate: () => string): string {
  let id = generate()
  while (RESERVED_ZONE_IDS.has(id)) id = generate()
  return id
}

// The single brand token reserved for Caracal's own internal systems and all future
// internal systems. It is encoded per object type to fit each field's character set,
// but it always denotes the same reserved namespace.
const RESERVED_NAMESPACE = 'caracal.sys'

// The object fields a tenant could otherwise use to squat or impersonate a Caracal
// internal system, each mapped to the reserved prefix in that field's encoding. Slugs
// and identifiers are lowercase by their own validation, so the comparison lowercases
// the value and every prefix is lowercase to match a name in any case.
export type ReservedObjectType = 'zoneSlug' | 'zoneName' | 'applicationName' | 'resourceIdentifier' | 'providerIdentifier' | 'policyName'

const RESERVED_PREFIX: Record<ReservedObjectType, string> = {
  zoneSlug: 'caracal-sys-',
  zoneName: 'caracal.sys/',
  applicationName: 'caracal.sys/',
  resourceIdentifier: 'caracal-sys://',
  providerIdentifier: 'provider://caracal-sys-',
  policyName: 'caracal.sys/',
}

export interface ReservedNamespaceError {
  error: string
  detail: string
}

// The bootstrap deployment identity that provisions and seals the reserved system zone. It
// is the only actor permitted to create, rename, or mutate anything in the reserved
// namespace; every other credential — the derived Console tokens, operator-minted admin
// tokens, and external tenants — is refused. Recognising the provisioner by its seed marker
// keeps the gate from trusting scope alone, since the Console write token is also global.
export function isInternalProvisioner(actor: Actor): boolean {
  return actor.createdBy === 'env-bootstrap'
}

// Whether a zone's own identity places it in the reserved system namespace, by either its
// reserved slug or its reserved name. The mutation gate uses this to keep the reserved
// system zone read-only to every actor but the internal provisioner.
export function isReservedZone(zone: { name?: string | null; slug?: string | null }): boolean {
  const name = (zone.name ?? '').trim().toLowerCase()
  const slug = (zone.slug ?? '').trim().toLowerCase()
  return name.startsWith(RESERVED_PREFIX.zoneName) || slug.startsWith(RESERVED_PREFIX.zoneSlug)
}

// A SQL boolean fragment (no bound parameters) selecting reserved system zones by the zones
// table's own name and slug columns. Built from the same reserved prefixes as the predicates
// above so the list filter and the mutation gate share one definition of the reserved
// namespace and cannot drift apart.
export const RESERVED_ZONE_SQL = `(lower(name) LIKE '${RESERVED_PREFIX.zoneName}%' OR lower(slug) LIKE '${RESERVED_PREFIX.zoneSlug}%')`

// Decides whether an actor may use a value in the reserved namespace. Only the internal
// provisioner (the bootstrap deployment identity) may create or rename objects into the
// reserved namespace; every other actor — including the global-scope Console and external
// admin tokens — is refused, so a tenant or an operator-minted credential can never squat or
// impersonate a Caracal internal system. The comparison is case-insensitive so a display
// name cannot evade by changing case. The detail names only that the namespace is reserved,
// never which internal objects exist, so the refusal does not map internal structure.
export function assertReservedNamespace(
  objectType: ReservedObjectType,
  value: string | undefined,
  actor: Actor,
): ReservedNamespaceError | null {
  if (value === undefined) return null
  const reserved = value.trim().toLowerCase().startsWith(RESERVED_PREFIX[objectType])
  if (reserved && !isInternalProvisioner(actor)) {
    return {
      error: 'reserved_namespace',
      detail: `the '${RESERVED_NAMESPACE}' namespace is reserved for Caracal internal systems`,
    }
  }
  return null
}
