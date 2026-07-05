-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts platform-wide created-by and updated-by attribution stamps.

ALTER TABLE public.audit_retention DROP COLUMN updated_by;

ALTER TABLE public.workloads
    DROP COLUMN created_by,
    DROP COLUMN created_via_operator,
    DROP COLUMN updated_via_operator;

ALTER TABLE public.delegated_grants
    DROP COLUMN created_by,
    DROP COLUMN created_via_operator,
    DROP COLUMN updated_by,
    DROP COLUMN updated_via_operator;

ALTER TABLE public.resources
    DROP COLUMN created_by,
    DROP COLUMN created_via_operator,
    DROP COLUMN updated_by,
    DROP COLUMN updated_via_operator;

ALTER TABLE public.providers
    DROP COLUMN created_by,
    DROP COLUMN created_via_operator,
    DROP COLUMN updated_by,
    DROP COLUMN updated_via_operator;

ALTER TABLE public.applications
    DROP COLUMN created_by,
    DROP COLUMN created_via_operator,
    DROP COLUMN updated_by,
    DROP COLUMN updated_via_operator,
    DROP COLUMN updated_at;

ALTER TABLE public.zones
    DROP COLUMN created_by,
    DROP COLUMN created_via_operator,
    DROP COLUMN updated_by,
    DROP COLUMN updated_via_operator;

ALTER TABLE public.policy_set_versions DROP COLUMN created_via_operator;
ALTER TABLE public.policy_versions DROP COLUMN created_via_operator;

ALTER TABLE public.policy_sets
    DROP COLUMN updated_by,
    DROP COLUMN updated_via_operator;
ALTER TABLE public.policy_sets RENAME COLUMN created_via_operator TO co_authored_by_operator;

ALTER TABLE public.policies
    DROP COLUMN updated_by,
    DROP COLUMN updated_via_operator;
ALTER TABLE public.policies RENAME COLUMN created_via_operator TO co_authored_by_operator;
