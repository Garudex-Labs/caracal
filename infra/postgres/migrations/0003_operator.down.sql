-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses the Caracal Operator conversation ledger tables; development and CI only, never invoked by production tooling.

DROP TABLE IF EXISTS public.operator_turns;
DROP TABLE IF EXISTS public.operator_conversations;
