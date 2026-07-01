-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts creator attribution: drops the Caracal Operator co-authorship stamp and its per-zone display setting.

ALTER TABLE public.zones DROP COLUMN operator_coauthor_badge;

ALTER TABLE public.policy_sets DROP COLUMN co_authored_by_operator;
ALTER TABLE public.policies DROP COLUMN co_authored_by_operator;
