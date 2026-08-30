-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Remove the legacy Teamspace layer. Ownership, sharing, review authority,
-- and membership are fully represented by the Organization -> Project model:
-- team-shared listings already carry a NOT NULL project_id, so dropping the
-- team axis loses no audience information.

-- Team lifecycle inbox items die with the concept.
DELETE FROM public.inbox_item_events WHERE item_id IN (
    SELECT id FROM public.inbox_items
    WHERE kind IN ('team_join_requested', 'team_join_decided', 'team_created_pending'));
DELETE FROM public.inbox_items
WHERE kind IN ('team_join_requested', 'team_join_decided', 'team_created_pending');

-- Re-home the private-subject snapshot from teamspaces to projects before
-- the mapping disappears.
ALTER TABLE public.inbox_items ADD COLUMN project_id uuid;
UPDATE public.inbox_items i SET project_id = p.id
FROM public.projects p
WHERE i.team_id IS NOT NULL AND p.legacy_team_id = i.team_id;
ALTER TABLE public.inbox_items DROP COLUMN team_id;

-- Rebuild inbox_kind without the team values.
ALTER TYPE public.inbox_kind RENAME TO inbox_kind_old;
CREATE TYPE public.inbox_kind AS ENUM (
    'review_requested',
    'review_approved',
    'review_rejected',
    'review_comment',
    'change_requested',
    'ownership_transfer',
    'update_available',
    'insight_ready',
    'system_notice'
);
ALTER TABLE public.inbox_items
    ALTER COLUMN kind TYPE public.inbox_kind USING kind::text::public.inbox_kind;
DROP TYPE public.inbox_kind_old;

-- Drop the team axis from agents and every listing family; the private-scope
-- invariant keeps its is_private half.
ALTER TABLE public.agents DROP CONSTRAINT ck_agents_private_scope;
ALTER TABLE public.agents ADD CONSTRAINT ck_agents_private_scope
    CHECK (((ownership_scope)::text <> 'private') OR is_private);
ALTER TABLE public.agents DROP COLUMN team_id;

ALTER TABLE public.mcp_listings DROP CONSTRAINT ck_mcp_listings_private_scope;
ALTER TABLE public.mcp_listings ADD CONSTRAINT ck_mcp_listings_private_scope
    CHECK (((ownership_scope)::text <> 'private') OR is_private);
ALTER TABLE public.mcp_listings DROP COLUMN team_id;

ALTER TABLE public.skill_listings DROP CONSTRAINT ck_skill_listings_private_scope;
ALTER TABLE public.skill_listings ADD CONSTRAINT ck_skill_listings_private_scope
    CHECK (((ownership_scope)::text <> 'private') OR is_private);
ALTER TABLE public.skill_listings DROP COLUMN team_id;

ALTER TABLE public.hook_listings DROP CONSTRAINT ck_hook_listings_private_scope;
ALTER TABLE public.hook_listings ADD CONSTRAINT ck_hook_listings_private_scope
    CHECK (((ownership_scope)::text <> 'private') OR is_private);
ALTER TABLE public.hook_listings DROP COLUMN team_id;

ALTER TABLE public.prompt_listings DROP CONSTRAINT ck_prompt_listings_private_scope;
ALTER TABLE public.prompt_listings ADD CONSTRAINT ck_prompt_listings_private_scope
    CHECK (((ownership_scope)::text <> 'private') OR is_private);
ALTER TABLE public.prompt_listings DROP COLUMN team_id;

ALTER TABLE public.sandbox_listings DROP CONSTRAINT ck_sandbox_listings_private_scope;
ALTER TABLE public.sandbox_listings ADD CONSTRAINT ck_sandbox_listings_private_scope
    CHECK (((ownership_scope)::text <> 'private') OR is_private);
ALTER TABLE public.sandbox_listings DROP COLUMN team_id;

ALTER TABLE public.component_sources DROP COLUMN team_id;

-- Projects no longer mirror teamspaces.
ALTER TABLE public.projects DROP COLUMN legacy_team_id;

-- The teamspace entity itself.
DROP TABLE public.team_membership_requests;
DROP TABLE public.team_invites;
DROP TABLE public.team_memberships;
DROP TABLE public.teams;
DROP TYPE public.team_join_request_status;
DROP TYPE public.teamrole;
