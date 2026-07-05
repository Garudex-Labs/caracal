// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Minimal URL helpers for server `req.url`-style paths (pathname + optional query).

/** Strips the query string (`?…`) from a URL or path fragment. */
export function pathOnly(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}
