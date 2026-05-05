-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds durable agent invocation state for coordinator-owned execution tracking.

CREATE TABLE agent_invocations (
    id                TEXT PRIMARY KEY,
    zone_id           TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    service_id        TEXT NOT NULL REFERENCES agent_services(id) ON DELETE CASCADE,
    source_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
    target_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
    idempotency_key   TEXT NOT NULL,
    method            TEXT NOT NULL,
    params_json       JSONB NOT NULL DEFAULT '{}',
    metadata_json     JSONB NOT NULL DEFAULT '{}',
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'running', 'succeeded', 'failed', 'cancel_requested', 'canceled', 'timed_out', 'dead'
    )),
    attempts          INT NOT NULL DEFAULT 0,
    max_attempts      INT NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    timeout_ms        INT NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),
    retry_policy_json JSONB NOT NULL DEFAULT '{}',
    error_json        JSONB,
    deadline_at       TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (zone_id, service_id, idempotency_key)
);

CREATE INDEX ON agent_invocations(zone_id, service_id, status, created_at DESC);
CREATE INDEX ON agent_invocations(zone_id, source_session_id, status) WHERE source_session_id IS NOT NULL;
CREATE INDEX ON agent_invocations(zone_id, target_session_id, status) WHERE target_session_id IS NOT NULL;
CREATE INDEX ON agent_invocations(deadline_at) WHERE status = 'running';

GRANT SELECT, INSERT, UPDATE ON agent_invocations TO caracalCoordinator;
GRANT SELECT ON agent_invocations TO caracalApi, caracalSts;