// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verb bodies for `caracal session …` admin commands (read-only).

import type { AdminClient, Session, SessionQuery } from '@caracalai/admin'

export interface SessionListOpts {
  client: AdminClient
  zoneId: string
  query?: SessionQuery
}

export function sessionList(opts: SessionListOpts): Promise<Session[]> {
  return opts.client.sessions.list(opts.zoneId, opts.query)
}
