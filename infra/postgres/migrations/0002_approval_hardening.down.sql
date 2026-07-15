-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses the approval hardening changes; development and CI only, never invoked by production tooling.

REVOKE INSERT ON TABLE public.event_outbox FROM caracalsts;
DROP INDEX IF EXISTS step_up_challenges_sweep_idx;
ALTER TABLE public.step_up_challenges DROP COLUMN IF EXISTS consumed_authority_record_id;
ALTER TABLE public.step_up_challenges DROP COLUMN IF EXISTS subject_anchor;
