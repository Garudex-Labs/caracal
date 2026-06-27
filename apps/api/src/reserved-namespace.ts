// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Server-side reservation of the Caracal-internal object namespace so tenants cannot create or impersonate platform-internal identities.

import type { Actor } from './auth.js'

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

// Decides whether an actor may use a value in the reserved namespace. Mirrors the
// privileged-trait-namespace gate: only a global-scope actor (the deployment platform)
// may create or rename objects into the reserved namespace; a zone-scoped tenant is
// refused. The comparison is case-insensitive so a display name cannot evade by changing
// case. The detail names only that the namespace is reserved, never which internal
// objects exist, so the refusal does not map internal structure for a caller.
export function assertReservedNamespace(
  objectType: ReservedObjectType,
  value: string | undefined,
  actor: Actor,
): ReservedNamespaceError | null {
  if (value === undefined) return null
  const reserved = value.trim().toLowerCase().startsWith(RESERVED_PREFIX[objectType])
  if (reserved && actor.scope !== 'global') {
    return {
      error: 'reserved_namespace',
      detail: `the '${RESERVED_NAMESPACE}' namespace is reserved for Caracal internal systems`,
    }
  }
  return null
}
