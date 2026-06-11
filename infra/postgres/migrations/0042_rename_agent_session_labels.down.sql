-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Restores the agent_sessions descriptor column name to capabilities.

ALTER TABLE agent_sessions RENAME COLUMN labels TO capabilities;
