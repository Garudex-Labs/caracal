// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Runtime exit codes and workload identity type exports.

export type { RuntimeIdentity } from '@caracalai/engine/runtime-config'

export const EXIT_CODES = {
  ok: 0,
  credentialFailed: 1,
  mcpBlocked: 1,
  childFailed: 2,
} as const
