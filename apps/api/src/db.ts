// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PostgreSQL connection pool for the API service.

import pg from 'pg'

export type DB = pg.Pool

export function newDB(connectionString: string): DB {
  return new pg.Pool({ connectionString, max: 20 })
}
