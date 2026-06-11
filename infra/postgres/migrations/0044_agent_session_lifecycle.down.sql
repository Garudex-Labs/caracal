-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Restores the three-value agent_kind descriptor.

UPDATE agent_sessions
    SET ttl_seconds = 3600
    WHERE ttl_seconds IS NULL;

ALTER TABLE agent_sessions
    ALTER COLUMN ttl_seconds SET NOT NULL;

DROP INDEX IF EXISTS agent_sessions_service_heartbeat_deadline_idx;

ALTER TABLE agent_sessions
    DROP CONSTRAINT IF EXISTS agent_sessions_lifecycle_check;

ALTER TABLE agent_sessions
    RENAME COLUMN lifecycle TO agent_kind;

UPDATE agent_sessions
    SET agent_kind = 'instance'
    WHERE agent_kind = 'task';

ALTER TABLE agent_sessions
    ALTER COLUMN agent_kind SET DEFAULT 'ephemeral';

ALTER TABLE agent_sessions
    ADD CONSTRAINT agent_sessions_agent_kind_check
    CHECK (agent_kind IN ('service', 'instance', 'ephemeral'));

CREATE INDEX IF NOT EXISTS agent_sessions_service_heartbeat_deadline_idx
    ON agent_sessions(heartbeat_deadline_at)
    WHERE status = 'active' AND agent_kind = 'service';
