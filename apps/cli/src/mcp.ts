// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// MCP shadow governance: detects unauthorized MCP server processes and blocks or logs.

import type { CliConfig } from './config.ts'

const KNOWN_MCP_INDICATORS = ['mcp-server', 'fastmcp', '@modelcontextprotocol']

export function checkMcpGovernance(args: string[] | string, cfg: CliConfig): void {
  const haystack = (Array.isArray(args) ? args : [args]).join(' ')
  const isUnauthorized = KNOWN_MCP_INDICATORS.some((ind) => haystack.includes(ind))
  if (!isUnauthorized) return

  const mode = cfg.mcp_governance?.mode ?? 'block'
  const action = mode === 'log' ? 'log' : 'blocked'
  process.stderr.write(JSON.stringify({ event: 'mcp_governance', action, cmd: haystack }) + '\n')
  if (mode !== 'log') process.exit(1)
}
