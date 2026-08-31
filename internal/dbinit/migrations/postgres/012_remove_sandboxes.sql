-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Remove the Sandbox resource. Sandbox is no longer a first-class Caracal
-- Resource: its execution/isolation concerns move to the Security/Policy and
-- local runtime architecture, and no read/write/install path references these
-- tables anymore. Drop the storage and narrow the review-issue subject enum.
-- CASCADE clears the circular listings<->versions FK and the downloads FKs.

DROP TABLE IF EXISTS public.sandbox_downloads CASCADE;
DROP TABLE IF EXISTS public.sandbox_versions CASCADE;
DROP TABLE IF EXISTS public.sandbox_listings CASCADE;

ALTER TABLE public.review_issues DROP CONSTRAINT IF EXISTS ck_review_issues_subject_type;
ALTER TABLE public.review_issues ADD CONSTRAINT ck_review_issues_subject_type
    CHECK ((subject_type)::text = ANY (ARRAY[
        ('agent'::character varying)::text,
        ('mcp'::character varying)::text,
        ('skill'::character varying)::text,
        ('hook'::character varying)::text,
        ('prompt'::character varying)::text]));
