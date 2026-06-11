-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Indexes audit metadata so events are filterable by agent identity and labels.

CREATE INDEX IF NOT EXISTS audit_events_agent_session_idx
    ON audit_events ((metadata_json->>'agent_session_id'))
    WHERE metadata_json ? 'agent_session_id';

CREATE INDEX IF NOT EXISTS audit_events_agent_labels_idx
    ON audit_events USING gin ((metadata_json->'agent_labels'));
