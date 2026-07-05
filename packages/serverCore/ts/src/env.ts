// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared environment classification for TypeScript services.

export type CaracalMode = 'dev' | 'rc' | 'stable';

export function caracalMode(): CaracalMode {
  const raw = (process.env.CARACAL_MODE ?? '').trim().toLowerCase();
  if (raw === '') return 'stable';
  if (raw === 'dev' || raw === 'rc' || raw === 'stable') return raw;
  throw new Error(`CARACAL_MODE must be 'dev', 'rc', or 'stable' (got '${raw}')`);
}

export function isPublished(): boolean {
  return caracalMode() !== 'dev';
}

export function assertPublishedSafe(): void {
  if (!isPublished()) return;
  const forbidden = ['INSECURE_STS', 'INSECURE_HTTP'];
  const set = forbidden.filter((k) => {
    const v = (process.env[k] ?? '').toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  });
  if (set.length > 0) {
    throw new Error(`CARACAL_MODE=rc or CARACAL_MODE=stable forbids: ${set.join(', ')}`);
  }
}
