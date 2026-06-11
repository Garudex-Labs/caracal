// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Request-scoped Postgres zone scope used to bind the caracal.zone_id RLS GUC per admin actor.

import { AsyncLocalStorage } from 'node:async_hooks'

export const GLOBAL_ZONE_SCOPE = '*'

const store = new AsyncLocalStorage<string>()

export function bindRequestZoneScope(scope: string): void {
  store.enterWith(scope)
}

export function currentZoneScope(): string {
  return store.getStore() ?? GLOBAL_ZONE_SCOPE
}
