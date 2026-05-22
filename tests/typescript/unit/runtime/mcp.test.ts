// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CLI MCP governance unit tests for block and log modes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkMcpGovernance } from '../../../../apps/cli/src/mcp.js'
import type { CliConfig } from '../../../../apps/cli/src/config.js'

const baseConfig: CliConfig = {
  zone_url: 'https://sts.example.com',
  app_client_id: 'zone1:app1',
  app_client_secret: 'secret',
}

describe('checkMcpGovernance', () => {
  let stderr = ''

  beforeEach(() => {
    stderr = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString()
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing for non-MCP commands', () => {
    checkMcpGovernance('node app.js', baseConfig)

    expect(stderr).toBe('')
    expect(process.exit).not.toHaveBeenCalled()
  })

  it('blocks unauthorized MCP commands by default', () => {
    expect(() => checkMcpGovernance('npx @modelcontextprotocol/server-filesystem', baseConfig)).toThrow('exit:1')

    expect(JSON.parse(stderr)).toMatchObject({ event: 'mcp_governance', action: 'blocked' })
  })

  it('logs unauthorized MCP commands when configured', () => {
    checkMcpGovernance('python -m fastmcp', { ...baseConfig, mcp_governance: { mode: 'log' } })

    expect(JSON.parse(stderr)).toMatchObject({ event: 'mcp_governance', action: 'log' })
    expect(process.exit).not.toHaveBeenCalled()
  })
})