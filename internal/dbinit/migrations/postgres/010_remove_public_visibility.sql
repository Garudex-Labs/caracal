-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Remove the "public" Resource visibility. Caracal scopes every Resource to a
-- Project: access is granted to the Project team (ownership_scope='project') or
-- to the individual owner (ownership_scope='private'). The former "public"
-- state was is_private=FALSE; those rows already carry their owning project_id,
-- so the deterministic, project-isolation-preserving migration is public ->
-- project: they become visible to their own Project's members, never globally.
--
-- is_private stays as a load-bearing storage/wire column but is pinned TRUE by a
-- CHECK so no path can recreate the public state; ownership_scope remains the
-- private/project discriminator.

-- agents
UPDATE public.agents SET is_private = TRUE, ownership_scope = 'project' WHERE is_private = FALSE;
ALTER TABLE public.agents ADD CONSTRAINT ck_agents_not_public CHECK (is_private);

-- mcp_listings
UPDATE public.mcp_listings SET is_private = TRUE, ownership_scope = 'project' WHERE is_private = FALSE;
ALTER TABLE public.mcp_listings ADD CONSTRAINT ck_mcp_listings_not_public CHECK (is_private);

-- skill_listings
UPDATE public.skill_listings SET is_private = TRUE, ownership_scope = 'project' WHERE is_private = FALSE;
ALTER TABLE public.skill_listings ADD CONSTRAINT ck_skill_listings_not_public CHECK (is_private);

-- hook_listings
UPDATE public.hook_listings SET is_private = TRUE, ownership_scope = 'project' WHERE is_private = FALSE;
ALTER TABLE public.hook_listings ADD CONSTRAINT ck_hook_listings_not_public CHECK (is_private);

-- prompt_listings
UPDATE public.prompt_listings SET is_private = TRUE, ownership_scope = 'project' WHERE is_private = FALSE;
ALTER TABLE public.prompt_listings ADD CONSTRAINT ck_prompt_listings_not_public CHECK (is_private);

-- sandbox_listings
UPDATE public.sandbox_listings SET is_private = TRUE, ownership_scope = 'project' WHERE is_private = FALSE;
ALTER TABLE public.sandbox_listings ADD CONSTRAINT ck_sandbox_listings_not_public CHECK (is_private);

-- component_sources: git import sources are Project-scoped only; drop the public axis.
ALTER TABLE public.component_sources DROP COLUMN IF EXISTS is_public;
