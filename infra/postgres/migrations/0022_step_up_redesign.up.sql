-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reshapes step-up challenges into single-live-hold approval facts with tier declarations, decisions, application binding, and an approve admin capability.

-- The decision contract emits exactly one challenge type. Secret-echo challenge
-- machinery has no issuing path, so its rows and the secret column are removed.
DELETE FROM public.step_up_challenges WHERE challenge_type <> 'human_approval';

ALTER TABLE public.step_up_challenges
    DROP CONSTRAINT step_up_challenges_challenge_type_check;

ALTER TABLE public.step_up_challenges
    ADD CONSTRAINT step_up_challenges_challenge_type_check CHECK ((challenge_type = 'human_approval'::text));

ALTER TABLE public.step_up_challenges
    DROP COLUMN challenge_secret_hash;

-- The resolved tier declaration is stored on the challenge so satisfaction and
-- display never re-derive policy data, plus the owning application for tenant
-- binding, the rejection decision, and the approver's session for forensics.
ALTER TABLE public.step_up_challenges
    ADD COLUMN application_id text REFERENCES public.applications(id) ON DELETE CASCADE,
    ADD COLUMN tier text,
    ADD COLUMN approver_class text DEFAULT 'operator'::text NOT NULL
        CONSTRAINT step_up_challenges_approver_class_check CHECK ((approver_class = ANY (ARRAY['operator'::text, 'subject'::text, 'any'::text]))),
    ADD COLUMN privacy_mode text DEFAULT 'identified'::text NOT NULL
        CONSTRAINT step_up_challenges_privacy_mode_check CHECK ((privacy_mode = ANY (ARRAY['identified'::text, 'pseudonymous'::text, 'anonymous'::text]))),
    ADD COLUMN rejected_at timestamp with time zone,
    ADD COLUMN decision_reason text,
    ADD COLUMN approver_session_id text;

CREATE INDEX step_up_challenges_application_idx ON public.step_up_challenges USING btree (application_id) WHERE (application_id IS NOT NULL);

-- One live hold per exact authority binding. Pending, satisfied, and rejected
-- rows all occupy the slot, so duplicate mints converge on one challenge and a
-- rejection stays authoritative until it expires; consumption frees the slot so
-- approvals remain single-use. Expired rows are purged at issuance.
CREATE UNIQUE INDEX step_up_challenges_live_binding_uniq ON public.step_up_challenges
    USING btree (zone_id, principal_id, session_id, resource_set_hash) NULLS NOT DISTINCT
    WHERE (consumed_at IS NULL);

CREATE INDEX step_up_challenges_expires_idx ON public.step_up_challenges USING btree (expires_at);

-- A third admin-token capability that releases approval holds and nothing else,
-- so a write credential cannot silently approve and an approver credential
-- cannot mutate configuration.
ALTER TABLE public.admin_tokens
    DROP CONSTRAINT admin_tokens_capability_check;

ALTER TABLE public.admin_tokens
    ADD CONSTRAINT admin_tokens_capability_check CHECK ((capability = ANY (ARRAY['read'::text, 'write'::text, 'approve'::text])));
