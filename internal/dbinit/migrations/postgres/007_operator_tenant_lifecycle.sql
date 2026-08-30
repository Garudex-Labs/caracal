-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Operator tenant lifecycle: suspension as the safe intermediate state
-- before deletion, plus the indexes the control-plane listings sort on.

ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS suspended_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_organizations_created_at
    ON public.organizations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_organizations_name
    ON public.organizations (lower(name));
CREATE INDEX IF NOT EXISTS idx_users_created_at
    ON public.users (created_at DESC);
