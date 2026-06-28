-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds keyset indexes that back the (zone_id, created_at DESC, id DESC) list pagination used by every zone-scoped list endpoint, plus the missing index on the agent_topology child foreign key so zone purge cascades stop sequentially scanning the topology.

CREATE INDEX IF NOT EXISTS agent_topology_child_id_idx
    ON public.agent_topology (child_id);

CREATE INDEX IF NOT EXISTS applications_zone_keyset_idx
    ON public.applications (zone_id, created_at DESC, id DESC)
    WHERE (archived_at IS NULL);

CREATE INDEX IF NOT EXISTS providers_zone_keyset_idx
    ON public.providers (zone_id, created_at DESC, id DESC)
    WHERE (archived_at IS NULL);

CREATE INDEX IF NOT EXISTS resources_zone_keyset_idx
    ON public.resources (zone_id, created_at DESC, id DESC)
    WHERE (archived_at IS NULL);

CREATE INDEX IF NOT EXISTS policies_zone_keyset_idx
    ON public.policies (zone_id, created_at DESC, id DESC)
    WHERE (archived_at IS NULL);

CREATE INDEX IF NOT EXISTS policy_sets_zone_keyset_idx
    ON public.policy_sets (zone_id, created_at DESC, id DESC)
    WHERE (archived_at IS NULL);

CREATE INDEX IF NOT EXISTS delegated_grants_zone_keyset_idx
    ON public.delegated_grants (zone_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS step_up_challenges_zone_keyset_idx
    ON public.step_up_challenges (zone_id, created_at DESC, id DESC);
