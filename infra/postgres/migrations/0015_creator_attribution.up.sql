-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Creator attribution: Caracal Operator co-authorship stamp on managed objects and its per-zone display setting.

ALTER TABLE public.policies ADD COLUMN co_authored_by_operator boolean NOT NULL DEFAULT false;
ALTER TABLE public.policy_sets ADD COLUMN co_authored_by_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.zones ADD COLUMN operator_coauthor_badge boolean NOT NULL DEFAULT true;
