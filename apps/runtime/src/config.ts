// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CLI exit codes and canonical caracal.toml config exports.

export type { CliConfig } from '@caracalai/engine/cli'

export const EXIT_CODES = {
  ok: 0,
  credentialFailed: 1,
  mcpBlocked: 1,
  childFailed: 2,
} as const
