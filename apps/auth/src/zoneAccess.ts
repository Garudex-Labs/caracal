// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Per-account zone access resolution for proxied coordinator traffic, cached briefly per operator and zone.

// The reserved system zone's identity prefixes, matching the API's reserved-namespace guard. The
// system zone is readable by every account for transparency but writable by no one through the
// Console, so proxied coordinator mutations against it are refused here.
const SYSTEM_ZONE_NAME_PREFIX = 'caracal.sys/'
const SYSTEM_ZONE_SLUG_PREFIX = 'caracal-sys-'

export interface ZoneProbeResult {
  status: number
  name?: string
  slug?: string
}

export interface ZoneAccessDecision {
  allowed: boolean
  status: number
  error?: string
}

interface ZoneAccessEntry {
  at: number
  status: number
  system: boolean
}

const ZONE_ACCESS_TTL_MS = 30_000
const ZONE_ACCESS_CACHE_MAX = 1_024
const zoneAccessCache = new Map<string, ZoneAccessEntry>()

export function clearZoneAccessCache(): void {
  zoneAccessCache.clear()
}

// Extracts the zone id from a coordinator proxy path, which is always /zones/:zoneId/... after
// prefix confinement. Anything that does not carry a zone id is refused rather than proxied.
export function coordZoneId(rest: string): string | null {
  const match = rest.match(/^\/zones\/([^/?]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function isSystemZoneRecord(zone: { name?: string; slug?: string }): boolean {
  const name = (zone.name ?? '').trim().toLowerCase()
  const slug = (zone.slug ?? '').trim().toLowerCase()
  return name.startsWith(SYSTEM_ZONE_NAME_PREFIX) || slug.startsWith(SYSTEM_ZONE_SLUG_PREFIX)
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

// Decides whether the signed-in operator may reach a zone-scoped coordinator path. Access is
// resolved by probing the admin API's zone read under the operator's account assertion, so the
// API's per-account ownership guard is the single authority: an owned zone answers 200, another
// account's zone answers 403, and a missing zone answers 403 or 404. The system zone answers its
// read as shared transparency, so mutations against it are refused here. Decisions are cached
// briefly per operator and zone to keep the guard off the coordinator hot path, and every
// non-owned outcome is fail-closed.
export async function resolveZoneAccess(
  accountId: string,
  zoneId: string,
  method: string,
  probe: () => Promise<ZoneProbeResult>,
): Promise<ZoneAccessDecision> {
  const key = `${accountId}:${zoneId}`
  const now = Date.now()
  let entry = zoneAccessCache.get(key)
  if (!entry || now - entry.at >= ZONE_ACCESS_TTL_MS) {
    const result = await probe()
    entry = {
      at: now,
      status: result.status,
      system: result.status === 200 && isSystemZoneRecord(result),
    }
    // Only definitive answers are cached; a transient probe failure is retried on the next
    // request rather than pinning the coordinator surface down for the cache window.
    if (entry.status === 200 || entry.status === 403 || entry.status === 404) {
      if (zoneAccessCache.size >= ZONE_ACCESS_CACHE_MAX) zoneAccessCache.clear()
      zoneAccessCache.set(key, entry)
    }
  }
  if (entry.status === 200) {
    if (entry.system && !isReadMethod(method.toUpperCase())) {
      return { allowed: false, status: 403, error: 'system_zone_read_only' }
    }
    return { allowed: true, status: 200 }
  }
  if (entry.status === 403) return { allowed: false, status: 403, error: 'zone_forbidden' }
  if (entry.status === 404) return { allowed: false, status: 404, error: 'zone_not_found' }
  if (entry.status === 503) return { allowed: false, status: 503, error: 'control_plane_not_configured' }
  return { allowed: false, status: 502, error: 'upstream_unreachable' }
}
