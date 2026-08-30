-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Onboarding foundation: profile completion marker, protected default
-- projects, and organization invitations.

-- Profile completion gates the onboarding profile stage; accounts that
-- predate the flow are grandfathered so they are never sent back into it.
ALTER TABLE public.users ADD COLUMN profile_completed_at timestamp with time zone;
UPDATE public.users SET profile_completed_at = created_at;

-- Every organization keeps exactly one default project that cannot be
-- deleted; access to it still flows through normal project permissions.
ALTER TABLE public.projects ADD COLUMN is_default boolean DEFAULT false NOT NULL;
CREATE UNIQUE INDEX uq_projects_default_per_org ON public.projects (organization_id) WHERE is_default;

INSERT INTO public.projects (id, organization_id, slug, name, description, created_by, is_default, created_at, updated_at)
SELECT gen_random_uuid(), o.id,
       CASE WHEN EXISTS (SELECT 1 FROM public.projects p WHERE p.organization_id = o.id AND p.slug = o.slug)
            THEN left(o.slug, 56) || '-default' ELSE o.slug END,
       o.name, NULL, o.created_by, true, now(), now()
FROM public.organizations o
WHERE NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.organization_id = o.id AND p.is_default);

-- Organization invitations: email-bound, expiring, single-acceptance. The
-- token is stored hashed; the encrypted copy lets org admins re-copy the link.
-- Acceptance relies on the baseline uq_org_memberships_org_user constraint
-- for idempotent joins.
CREATE TABLE public.org_invitations (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    email character varying(255) NOT NULL,
    role public.organization_role NOT NULL,
    token_hash character varying(64) NOT NULL,
    token_encrypted text,
    invited_by uuid,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by uuid,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT uq_org_invitations_token_hash UNIQUE (token_hash);
ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT fk_org_invitations_organization FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT fk_org_invitations_invited_by FOREIGN KEY (invited_by)
    REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT fk_org_invitations_accepted_by FOREIGN KEY (accepted_by)
    REFERENCES public.users(id) ON DELETE SET NULL;

-- One live invitation per address per organization: retries return the
-- existing row instead of minting duplicates.
CREATE UNIQUE INDEX uq_org_invitations_pending_email
    ON public.org_invitations (organization_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX ix_org_invitations_email ON public.org_invitations (lower(email));
