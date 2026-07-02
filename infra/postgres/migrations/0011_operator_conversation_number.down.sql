-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses the per-zone Operator conversation number; development and CI only, never invoked by production tooling.

DROP INDEX IF EXISTS operator_conversations_zone_number_idx;

ALTER TABLE public.operator_conversations
    DROP COLUMN IF EXISTS number;
