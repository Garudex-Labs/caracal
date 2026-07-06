-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Restores the shadow-version and scope-type columns and removes the single-active-set index; development and CI only, never invoked by production tooling.

DROP INDEX IF EXISTS public.policy_set_bindings_one_active_per_zone;

ALTER TABLE public.policy_set_bindings ADD COLUMN IF NOT EXISTS shadow_version_id text;

ALTER TABLE ONLY public.policy_set_bindings
    ADD CONSTRAINT policy_set_bindings_shadow_version_id_fkey FOREIGN KEY (shadow_version_id) REFERENCES public.policy_set_versions(id);

ALTER TABLE public.policy_sets ADD COLUMN IF NOT EXISTS scope_type text DEFAULT 'zone'::text NOT NULL;
ALTER TABLE public.policy_sets ADD COLUMN IF NOT EXISTS owner_type text DEFAULT 'customer'::text NOT NULL;
ALTER TABLE public.policies ADD COLUMN IF NOT EXISTS owner_type text DEFAULT 'customer'::text NOT NULL;
