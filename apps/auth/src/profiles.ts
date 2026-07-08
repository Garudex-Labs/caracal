// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Resolves profile ids to current display names for the console's attribution rendering.

// Attribution fields persist immutable profile ids; the console asks this surface for the
// current display names at render time, so a rename is reflected across all historical
// records without rewriting what they store.

// A defensive ceiling per request: attribution rendering batches the ids visible on one page,
// which is far below this.
const MAX_IDS = 100
// Better Auth ids are compact url-safe identifiers; anything else is not a profile id and is
// dropped rather than queried.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
// Direct API automation is attributed as `admin:<token uuid>`; those identities resolve to the
// admin token's name instead of the auth store.
const ADMIN_ID_PATTERN = /^admin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Profile {
  id: string
  name: string
}

export interface ParsedIds {
  profiles: string[]
  admins: string[]
}

// The minimal Better Auth adapter surface the lookup needs, typed structurally so tests can
// exercise the parsing and shaping without an auth instance.
export interface ProfileAdapter {
  findMany(input: { model: string; where: { field: string; operator: 'in'; value: string[] }[]; limit: number }): Promise<unknown[]>
}

// Parses the ids query parameter into bounded, deduplicated lists of well-formed profile ids
// and admin credential identities.
export function parseProfileIds(url: string): ParsedIds {
  let raw: string
  try {
    raw = new URL(url, 'http://localhost').searchParams.get('ids') ?? ''
  } catch {
    return { profiles: [], admins: [] }
  }
  const profiles = new Set<string>()
  const admins = new Set<string>()
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (id.length === 0) continue
    if (ID_PATTERN.test(id)) profiles.add(id)
    else if (ADMIN_ID_PATTERN.test(id)) admins.add(id)
    if (profiles.size + admins.size >= MAX_IDS) break
  }
  return { profiles: [...profiles], admins: [...admins] }
}

// Looks up the current display names for the requested ids. Unknown ids are simply absent from
// the result - the console then renders the stored identity verbatim - and only id and name
// ever leave this surface, never emails or other account fields.
export async function resolveProfiles(adapter: ProfileAdapter, ids: string[]): Promise<Profile[]> {
  if (ids.length === 0) return []
  const rows = await adapter.findMany({
    model: 'user',
    where: [{ field: 'id', operator: 'in', value: ids }],
    limit: ids.length,
  })
  const profiles: Profile[] = []
  for (const row of rows) {
    const user = row as { id?: unknown; name?: unknown }
    if (typeof user.id !== 'string') continue
    profiles.push({ id: user.id, name: typeof user.name === 'string' ? user.name : '' })
  }
  return profiles
}

// Shapes the admin token listing into profiles for the requested `admin:<id>` identities, so
// attribution recorded for direct API automation renders as the token's name. Only id and name
// leave this surface; unknown identities are simply absent and render verbatim.
export function adminTokenProfiles(tokens: unknown[], ids: string[]): Profile[] {
  const wanted = new Set(ids.map((id) => id.toLowerCase()))
  const profiles: Profile[] = []
  for (const row of tokens) {
    const token = row as { id?: unknown; name?: unknown }
    if (typeof token.id !== 'string' || typeof token.name !== 'string' || token.name.length === 0) continue
    const identity = `admin:${token.id}`
    if (wanted.has(identity.toLowerCase())) profiles.push({ id: identity, name: token.name })
  }
  return profiles
}
