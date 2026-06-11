-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Renames the agent_sessions descriptor column from capabilities to labels.

ALTER TABLE agent_sessions RENAME COLUMN capabilities TO labels;
