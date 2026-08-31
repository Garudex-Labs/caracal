-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Materialize protected default project membership for existing organizations.

INSERT INTO public.project_memberships (id, project_id, organization_id, user_id, role, created_at)
SELECT format(
        '%s-%s-%s-%s-%s',
        substr(md5(p.id::text || ':' || om.user_id::text), 1, 8),
        substr(md5(p.id::text || ':' || om.user_id::text), 9, 4),
        substr(md5(p.id::text || ':' || om.user_id::text), 13, 4),
        substr(md5(p.id::text || ':' || om.user_id::text), 17, 4),
        substr(md5(p.id::text || ':' || om.user_id::text), 21, 12)
    )::uuid,
    p.id,
    p.organization_id,
    om.user_id,
    CASE WHEN om.role IN ('owner', 'admin') THEN 'lead'::public.project_role ELSE 'user'::public.project_role END,
    om.created_at
FROM public.projects p
JOIN public.organization_memberships om ON om.organization_id = p.organization_id
WHERE p.is_default
ON CONFLICT (project_id, user_id) DO UPDATE
SET role = EXCLUDED.role;