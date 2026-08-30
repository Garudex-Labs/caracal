-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
-- SPDX-License-Identifier: Apache-2.0
-- Drop the demo-account flag: accounts are only created through the real
-- identity flow, so no user can be a seeded demo account.

ALTER TABLE public.users DROP COLUMN IF EXISTS is_demo;
