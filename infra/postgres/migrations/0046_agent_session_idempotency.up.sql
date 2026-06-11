-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Stores the caller-supplied idempotency key on agent sessions so spawn replays match by key.

ALTER TABLE agent_sessions
    ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX agent_sessions_idempotency_key_idx
    ON agent_sessions(zone_id, application_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status IN ('active', 'suspended');
