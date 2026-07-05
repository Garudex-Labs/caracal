// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator-token guard for agent and delegation commands.

import { discoverCoordinatorToken } from '@caracalai/server-core'

export function ensureCoordinatorToken(): void {
  if (!discoverCoordinatorToken()) {
    throw new Error('Coordinator token not found; run `caracal up` or set CARACAL_COORDINATOR_TOKEN for agent/delegation commands.')
  }
}
