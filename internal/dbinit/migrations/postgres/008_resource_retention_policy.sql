-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Resource deletion retention policy and scheduled permanent deletion.

ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS scheduled_purge_at timestamp with time zone;

CREATE TABLE IF NOT EXISTS public.project_resource_retention_policies (
    project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
    private_retention_days integer NOT NULL DEFAULT 30,
    project_retention_days integer NOT NULL DEFAULT 30,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT ck_project_resource_retention_private_range
        CHECK (private_retention_days >= 0 AND private_retention_days <= 90),
    CONSTRAINT ck_project_resource_retention_project_range
        CHECK (project_retention_days >= 7 AND project_retention_days <= 180)
);

UPDATE public.agents
SET scheduled_purge_at = deleted_at + interval '30 days'
WHERE deleted_at IS NOT NULL AND scheduled_purge_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agents_scheduled_purge_at
    ON public.agents (scheduled_purge_at)
    WHERE deleted_at IS NOT NULL AND scheduled_purge_at IS NOT NULL;
