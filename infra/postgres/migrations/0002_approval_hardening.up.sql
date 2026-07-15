-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Hardens approval holds: subject anchoring, consumption attribution, sweep index, and STS audit outbox access.

-- Anchors a hold to the federated Subject the gated execution acts for; the STS
-- reserves subject-plane decisions on an anchored hold for that exact Subject.
-- Rows created before this column exists stay decidable by any of the
-- application's federated end users, matching their issuance-time contract.
ALTER TABLE public.step_up_challenges ADD COLUMN subject_anchor text;

-- Records the authority record a consumption created, so a retry that lost the
-- success response can re-issue a bearer for the same authority instead of
-- burning the approval and asking the human to decide again.
ALTER TABLE public.step_up_challenges ADD COLUMN consumed_authority_record_id text;

-- The retention sweep deletes rows whose lifecycle ended before the cutoff; this
-- expression matches the sweep predicate exactly so cleanup stays an index range
-- scan at any volume.
CREATE INDEX step_up_challenges_sweep_idx ON public.step_up_challenges
    USING btree (GREATEST(COALESCE(consumed_at, '-infinity'::timestamp with time zone), COALESCE(rejected_at, '-infinity'::timestamp with time zone), expires_at));

-- The STS writes approval decision audit events through the transactional outbox
-- inside the decision's own transaction; the shared dispatcher drains them to the
-- audit stream.
GRANT INSERT ON TABLE public.event_outbox TO caracalsts;
