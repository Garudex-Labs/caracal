// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// caracal.toml config shape for the CLI.

export interface Credential {
  env: string
  resource: string
}

export interface OptionalCredential extends Credential {
  on_failure: 'warn' | 'error'
}

export interface McpGovernance {
  mode: 'block' | 'log'
}

export interface CliConfig {
  zone_url: string
  zone_id?: string
  app_client_id: string
  app_client_secret: string
  continue_on_failure?: boolean
  credentials?: Credential[]
  optional_credentials?: OptionalCredential[]
  mcp_governance?: McpGovernance
}

export const EXIT_CODES = {
  ok: 0,
  credentialFailed: 1,
  mcpBlocked: 1,
  childFailed: 2,
} as const
