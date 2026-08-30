-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Rename the shared ownership_scope value 'team' to 'project'. The audience is
-- the owning project's members; the legacy teamspace entity is gone, so the
-- value now names what it actually means.

-- agents
ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS ck_agents_scope_valid;
UPDATE public.agents SET ownership_scope = 'project' WHERE ownership_scope = 'team';
ALTER TABLE public.agents ALTER COLUMN ownership_scope SET DEFAULT 'project';
ALTER TABLE public.agents ADD CONSTRAINT ck_agents_scope_valid
    CHECK ((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('project'::character varying)::text]));

-- mcp_listings
ALTER TABLE public.mcp_listings DROP CONSTRAINT IF EXISTS ck_mcp_listings_scope_valid;
UPDATE public.mcp_listings SET ownership_scope = 'project' WHERE ownership_scope = 'team';
ALTER TABLE public.mcp_listings ALTER COLUMN ownership_scope SET DEFAULT 'project';
ALTER TABLE public.mcp_listings ADD CONSTRAINT ck_mcp_listings_scope_valid
    CHECK ((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('project'::character varying)::text]));

-- skill_listings
ALTER TABLE public.skill_listings DROP CONSTRAINT IF EXISTS ck_skill_listings_scope_valid;
UPDATE public.skill_listings SET ownership_scope = 'project' WHERE ownership_scope = 'team';
ALTER TABLE public.skill_listings ALTER COLUMN ownership_scope SET DEFAULT 'project';
ALTER TABLE public.skill_listings ADD CONSTRAINT ck_skill_listings_scope_valid
    CHECK ((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('project'::character varying)::text]));

-- hook_listings
ALTER TABLE public.hook_listings DROP CONSTRAINT IF EXISTS ck_hook_listings_scope_valid;
UPDATE public.hook_listings SET ownership_scope = 'project' WHERE ownership_scope = 'team';
ALTER TABLE public.hook_listings ALTER COLUMN ownership_scope SET DEFAULT 'project';
ALTER TABLE public.hook_listings ADD CONSTRAINT ck_hook_listings_scope_valid
    CHECK ((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('project'::character varying)::text]));

-- prompt_listings
ALTER TABLE public.prompt_listings DROP CONSTRAINT IF EXISTS ck_prompt_listings_scope_valid;
UPDATE public.prompt_listings SET ownership_scope = 'project' WHERE ownership_scope = 'team';
ALTER TABLE public.prompt_listings ALTER COLUMN ownership_scope SET DEFAULT 'project';
ALTER TABLE public.prompt_listings ADD CONSTRAINT ck_prompt_listings_scope_valid
    CHECK ((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('project'::character varying)::text]));

-- sandbox_listings
ALTER TABLE public.sandbox_listings DROP CONSTRAINT IF EXISTS ck_sandbox_listings_scope_valid;
UPDATE public.sandbox_listings SET ownership_scope = 'project' WHERE ownership_scope = 'team';
ALTER TABLE public.sandbox_listings ALTER COLUMN ownership_scope SET DEFAULT 'project';
ALTER TABLE public.sandbox_listings ADD CONSTRAINT ck_sandbox_listings_scope_valid
    CHECK ((ownership_scope)::text = ANY (ARRAY[('private'::character varying)::text, ('project'::character varying)::text]));
