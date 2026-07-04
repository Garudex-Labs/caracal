-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts the step-up approval fact model to the secret-capable challenge shape and the read/write admin capability set.

ALTER TABLE public.admin_tokens
    DROP CONSTRAINT admin_tokens_capability_check;

UPDATE public.admin_tokens SET capability = 'read' WHERE capability = 'approve';

ALTER TABLE public.admin_tokens
    ADD CONSTRAINT admin_tokens_capability_check CHECK ((capability = ANY (ARRAY['read'::text, 'write'::text])));

DROP INDEX IF EXISTS public.step_up_challenges_expires_idx;
DROP INDEX IF EXISTS public.step_up_challenges_live_binding_uniq;
DROP INDEX IF EXISTS public.step_up_challenges_application_idx;

ALTER TABLE public.step_up_challenges
    DROP COLUMN approver_session_id,
    DROP COLUMN decision_reason,
    DROP COLUMN rejected_at,
    DROP COLUMN privacy_mode,
    DROP COLUMN approver_class,
    DROP COLUMN tier,
    DROP COLUMN application_id;

ALTER TABLE public.step_up_challenges
    ADD COLUMN challenge_secret_hash bytea;

ALTER TABLE public.step_up_challenges
    DROP CONSTRAINT step_up_challenges_challenge_type_check;

ALTER TABLE public.step_up_challenges
    ADD CONSTRAINT step_up_challenges_challenge_type_check CHECK ((challenge_type = ANY (ARRAY['human_approval'::text, 'mfa'::text, 'software_attestation'::text])));
