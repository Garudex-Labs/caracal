-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Enforces one active policy set per zone and drops the unused shadow-version and scope-type columns.

-- A zone is governed by exactly one policy set. Where several bindings are active,
-- keep the most recently updated one and deactivate the rest before the unique
-- index below makes the invariant structural.
UPDATE public.policy_set_bindings psb
SET active_version_id = NULL, updated_at = now()
WHERE psb.active_version_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.policy_set_bindings newer
    WHERE newer.zone_id = psb.zone_id
      AND newer.active_version_id IS NOT NULL
      AND (newer.updated_at > psb.updated_at
           OR (newer.updated_at = psb.updated_at AND newer.policy_set_id > psb.policy_set_id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS policy_set_bindings_one_active_per_zone
  ON public.policy_set_bindings (zone_id)
  WHERE active_version_id IS NOT NULL;

ALTER TABLE public.policy_set_bindings DROP COLUMN IF EXISTS shadow_version_id;

ALTER TABLE public.policy_sets DROP COLUMN IF EXISTS scope_type;
ALTER TABLE public.policy_sets DROP COLUMN IF EXISTS owner_type;
ALTER TABLE public.policies DROP COLUMN IF EXISTS owner_type;
