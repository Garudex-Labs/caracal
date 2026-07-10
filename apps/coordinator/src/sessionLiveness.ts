// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared SQL predicates for governed Session liveness.

export const SESSION_LIVE_SQL = `(CASE WHEN lifecycle = 'service'
  THEN heartbeat_deadline_at IS NOT NULL AND heartbeat_deadline_at > now()
  ELSE ttl_seconds IS NOT NULL AND started_at + (ttl_seconds * interval '1 second') > now()
END)`
