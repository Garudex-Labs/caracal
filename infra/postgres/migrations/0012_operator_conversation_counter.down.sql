-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses the durable per-zone Operator conversation counter; development and CI only, never invoked by production tooling.

DROP TABLE IF EXISTS public.operator_conversation_counters;
