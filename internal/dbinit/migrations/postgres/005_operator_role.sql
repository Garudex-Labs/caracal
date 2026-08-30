-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Split deployment operators from organization administration terminology.

ALTER TYPE public.userrole RENAME TO userrole_old;
CREATE TYPE public.userrole AS ENUM (
    'operator',
    'reviewer',
    'user'
);

ALTER TABLE public.users
    ALTER COLUMN role TYPE public.userrole
    USING CASE
        WHEN role::text IN ('super_admin', 'admin') THEN 'operator'
        ELSE role::text
    END::public.userrole;

DROP TYPE public.userrole_old;

DO $$
BEGIN
    IF to_regclass('public."user"') IS NOT NULL THEN
        UPDATE public."user"
        SET role = 'operator'
        WHERE role IN ('super_admin', 'admin');
    END IF;
END $$;
