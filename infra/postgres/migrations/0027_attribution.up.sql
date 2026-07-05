-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Platform-wide attribution: created-by and updated-by stamps with Operator involvement flags on every governed entity.

-- Policies and policy sets already carry creation attribution; the Operator flag is
-- renamed to the platform-wide vocabulary and the update-side stamp is added.
ALTER TABLE public.policies RENAME COLUMN co_authored_by_operator TO created_via_operator;
ALTER TABLE public.policies
    ADD COLUMN updated_by text,
    ADD COLUMN updated_via_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.policy_sets RENAME COLUMN co_authored_by_operator TO created_via_operator;
ALTER TABLE public.policy_sets
    ADD COLUMN updated_by text,
    ADD COLUMN updated_via_operator boolean NOT NULL DEFAULT false;

-- Version rows are immutable, so they carry creation attribution only.
ALTER TABLE public.policy_versions ADD COLUMN created_via_operator boolean NOT NULL DEFAULT false;
ALTER TABLE public.policy_set_versions ADD COLUMN created_via_operator boolean NOT NULL DEFAULT false;

-- created_by stays NULL on rows that predate attribution: an invented backfill value
-- would corrupt the governance record, and the console renders the absence explicitly.
ALTER TABLE public.zones
    ADD COLUMN created_by text,
    ADD COLUMN created_via_operator boolean NOT NULL DEFAULT false,
    ADD COLUMN updated_by text,
    ADD COLUMN updated_via_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.applications
    ADD COLUMN created_by text,
    ADD COLUMN created_via_operator boolean NOT NULL DEFAULT false,
    ADD COLUMN updated_by text,
    ADD COLUMN updated_via_operator boolean NOT NULL DEFAULT false,
    ADD COLUMN updated_at timestamp with time zone;

ALTER TABLE public.providers
    ADD COLUMN created_by text,
    ADD COLUMN created_via_operator boolean NOT NULL DEFAULT false,
    ADD COLUMN updated_by text,
    ADD COLUMN updated_via_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.resources
    ADD COLUMN created_by text,
    ADD COLUMN created_via_operator boolean NOT NULL DEFAULT false,
    ADD COLUMN updated_by text,
    ADD COLUMN updated_via_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.delegated_grants
    ADD COLUMN created_by text,
    ADD COLUMN created_via_operator boolean NOT NULL DEFAULT false,
    ADD COLUMN updated_by text,
    ADD COLUMN updated_via_operator boolean NOT NULL DEFAULT false;

ALTER TABLE public.workloads
    ADD COLUMN created_by text,
    ADD COLUMN created_via_operator boolean NOT NULL DEFAULT false,
    ADD COLUMN updated_via_operator boolean NOT NULL DEFAULT false;

-- The retention window is a global compliance dial; record who last set it.
ALTER TABLE public.audit_retention ADD COLUMN updated_by text;
