// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared environment variable accessors for TypeScript services.

export function mustGetenv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Required env var missing: ${key}`);
  return v;
}

export function getenv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}
