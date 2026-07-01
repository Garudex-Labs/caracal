-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Durable termination reason on agent sessions so audit shows why an agent ended.

ALTER TABLE public.agent_sessions ADD COLUMN termination_reason text;
