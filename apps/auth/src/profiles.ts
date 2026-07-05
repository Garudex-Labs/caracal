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

export interface Profile {
  id: string
  name: string
}

// The minimal Better Auth adapter surface the lookup needs, typed structurally so tests can
// exercise the parsing and shaping without an auth instance.
export interface ProfileAdapter {
  findMany(input: { model: string; where: { field: string; operator: 'in'; value: string[] }[]; limit: number }): Promise<unknown[]>
}

// Parses the ids query parameter into a bounded, deduplicated list of well-formed profile ids.
export function parseProfileIds(url: string): string[] {
  let raw: string
  try {
    raw = new URL(url, 'http://localhost').searchParams.get('ids') ?? ''
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (id.length > 0 && ID_PATTERN.test(id)) ids.add(id)
    if (ids.size >= MAX_IDS) break
  }
  return [...ids]
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
