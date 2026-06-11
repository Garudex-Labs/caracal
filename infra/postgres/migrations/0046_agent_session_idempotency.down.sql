-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes the agent session idempotency key column and its unique index.

DROP INDEX IF EXISTS agent_sessions_idempotency_key_idx;

ALTER TABLE agent_sessions
    DROP COLUMN IF EXISTS idempotency_key;
