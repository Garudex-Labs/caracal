// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared environment classification for TypeScript services.

export function caracalEnv(): string {
  return process.env.CARACAL_ENV ?? 'development';
}

export function isProduction(): boolean {
  const env = caracalEnv();
  return env === 'production' || env === 'prod' || env === 'staging';
}
