// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Postgres token state connector unit tests.

import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  MCP_TOKEN_STATE_DDL,
  PostgresBackend,
} from '../../../../../packages/connectors/postgres/ts/src/postgres.js'

function makePool(rows: unknown[] = []): Pool {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as Pool
}

describe('PostgresBackend', () => {
  it('runs the token state migration DDL', async () => {
    const pool = makePool()
    await new PostgresBackend(pool).migrate()
    expect(pool.query).toHaveBeenCalledWith(MCP_TOKEN_STATE_DDL)
  })

  it('upserts token state by zone and subject', async () => {
    const pool = makePool()
    const expiresAt = new Date('2026-01-01T00:00:00Z')

    await new PostgresBackend(pool).upsert('zone-1', 'user-1', 'tool:call', expiresAt)

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (zone_id, sub)'), [
      'zone-1',
      'user-1',
      'tool:call',
      expiresAt,
    ])
  })

  it('returns the selected token state row or null', async () => {
    const row = {
      zoneId: 'zone-1',
      sub: 'user-1',
      scope: 'tool:call',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:01Z'),
    }
    const pool = makePool([row])

    await expect(new PostgresBackend(pool).get('zone-1', 'user-1')).resolves.toBe(row)
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM mcp_token_state'), [
      'zone-1',
      'user-1',
    ])

    await expect(new PostgresBackend(makePool()).get('zone-1', 'missing')).resolves.toBeNull()
  })

  it('deletes token state by zone and subject', async () => {
    const pool = makePool()

    await new PostgresBackend(pool).delete('zone-1', 'user-1')

    expect(pool.query).toHaveBeenCalledWith('DELETE FROM mcp_token_state WHERE zone_id = $1 AND sub = $2', [
      'zone-1',
      'user-1',
    ])
  })
})
