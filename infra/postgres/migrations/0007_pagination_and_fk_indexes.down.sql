-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses the list pagination keyset indexes and the agent_topology child foreign key index; development and CI only, never invoked by production tooling.

DROP INDEX IF EXISTS public.step_up_challenges_zone_keyset_idx;
DROP INDEX IF EXISTS public.delegated_grants_zone_keyset_idx;
DROP INDEX IF EXISTS public.policy_sets_zone_keyset_idx;
DROP INDEX IF EXISTS public.policies_zone_keyset_idx;
DROP INDEX IF EXISTS public.resources_zone_keyset_idx;
DROP INDEX IF EXISTS public.providers_zone_keyset_idx;
DROP INDEX IF EXISTS public.applications_zone_keyset_idx;
DROP INDEX IF EXISTS public.agent_topology_child_id_idx;
