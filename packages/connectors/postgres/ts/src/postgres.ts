// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgresBackend: persists per-user MCP token state in PostgreSQL.

import { Pool } from 'pg'

export interface TokenState {
  zoneId: string
  sub: string
  scope: string
  expiresAt: Date
  updatedAt: Date
}

export const MCP_TOKEN_STATE_DDL = `
CREATE TABLE IF NOT EXISTS mcp_token_state (
  zone_id    TEXT        NOT NULL,
  sub        TEXT        NOT NULL,
  scope      TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (zone_id, sub)
);
`

export class PostgresBackend {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(MCP_TOKEN_STATE_DDL)
  }

  async upsert(zoneId: string, sub: string, scope: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO mcp_token_state (zone_id, sub, scope, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (zone_id, sub) DO UPDATE
         SET scope = EXCLUDED.scope,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [zoneId, sub, scope, expiresAt],
    )
  }

  async get(zoneId: string, sub: string): Promise<TokenState | null> {
    const { rows } = await this.pool.query<TokenState>(
      `SELECT zone_id AS "zoneId", sub, scope, expires_at AS "expiresAt", updated_at AS "updatedAt"
       FROM mcp_token_state WHERE zone_id = $1 AND sub = $2`,
      [zoneId, sub],
    )
    return rows[0] ?? null
  }

  async delete(zoneId: string, sub: string): Promise<void> {
    await this.pool.query('DELETE FROM mcp_token_state WHERE zone_id = $1 AND sub = $2', [zoneId, sub])
  }
}
