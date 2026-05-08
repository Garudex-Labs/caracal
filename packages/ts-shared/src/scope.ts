// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Canonical OAuth 2.0 scope-string parser shared across all TS callers.

// parseScope splits an OAuth 2.0 scope string per RFC 6749 §3.3: tokens are
// separated by ASCII whitespace and empty tokens are ignored. Returns a
// distinct, order-preserving array.
export function parseScope(scope: string | null | undefined): string[] {
  if (!scope) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of scope.split(/\s+/)) {
    if (token === '' || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

// hasScope reports whether the parsed scope grants `required`. Empty `required`
// is treated as a programming error and never matches.
export function hasScope(scope: string | null | undefined, required: string): boolean {
  if (!required) return false
  return parseScope(scope).includes(required)
}

// scopesAllowed reports whether every scope in `requested` is present in `available`.
export function scopesAllowed(requested: string[], available: string[]): boolean {
  const allowed = new Set(available)
  return requested.every((s) => allowed.has(s))
}
