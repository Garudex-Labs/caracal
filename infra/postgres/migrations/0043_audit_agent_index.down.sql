-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Drops the audit metadata indexes for agent identity and labels.

DROP INDEX IF EXISTS audit_events_agent_labels_idx;
DROP INDEX IF EXISTS audit_events_agent_session_idx;
