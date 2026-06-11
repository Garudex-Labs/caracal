-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Collapses the agent session descriptor to two real lifecycles and renames it to lifecycle.

ALTER TABLE agent_sessions
    DROP CONSTRAINT IF EXISTS agent_sessions_agent_kind_check;

UPDATE agent_sessions
    SET agent_kind = 'task'
    WHERE agent_kind IN ('instance', 'ephemeral');

ALTER TABLE agent_sessions
    RENAME COLUMN agent_kind TO lifecycle;

ALTER TABLE agent_sessions
    ALTER COLUMN lifecycle SET DEFAULT 'task';

ALTER TABLE agent_sessions
    ADD CONSTRAINT agent_sessions_lifecycle_check
    CHECK (lifecycle IN ('task', 'service'));

ALTER TABLE agent_sessions
    ALTER COLUMN ttl_seconds DROP NOT NULL;

UPDATE agent_sessions
    SET ttl_seconds = NULL
    WHERE lifecycle = 'service';

DROP INDEX IF EXISTS agent_sessions_service_heartbeat_deadline_idx;

CREATE INDEX IF NOT EXISTS agent_sessions_service_heartbeat_deadline_idx
    ON agent_sessions(heartbeat_deadline_at)
    WHERE status = 'active' AND lifecycle = 'service';
