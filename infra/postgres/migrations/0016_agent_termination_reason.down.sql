-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts the durable termination reason on agent sessions.

ALTER TABLE public.agent_sessions DROP COLUMN termination_reason;
