// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared environment variable accessors for TypeScript services.

import { readFileSync } from 'node:fs';

export function mustGetenv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Required env var missing: ${key}`);
  return v;
}

export function getenv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export function intEnv(key: string, fallback: number, min = 0): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`Invalid integer env var ${key}: ${raw}`);
  }
  return n;
}

export function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  switch (raw.toLowerCase()) {
    case '1': case 'true': case 'yes': case 'on': return true;
    case '0': case 'false': case 'no': case 'off': return false;
    default: throw new Error(`Invalid boolean env var ${key}: ${raw}`);
  }
}

// resolveFileSecrets reads `${KEY}_FILE` for each given key and, when set,
// loads the file contents into `process.env[KEY]`. The `_FILE` variable is
// cleared so secrets do not appear in the process environment beyond what is
// actually needed at runtime. Existing values for `KEY` are preserved.
export function resolveFileSecrets(keys: readonly string[]): void {
  for (const key of keys) {
    if (process.env[key]) continue;
    const fileVar = `${key}_FILE`;
    const path = process.env[fileVar];
    if (!path) continue;
    const value = readFileSync(path, 'utf8').replace(/\s+$/, '');
    if (!value) throw new Error(`Secret file empty: ${fileVar}=${path}`);
    process.env[key] = value;
    delete process.env[fileVar];
  }
}
