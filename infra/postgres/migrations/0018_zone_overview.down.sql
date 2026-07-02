-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts the live-session count index.

DROP INDEX IF EXISTS public.sessions_zone_active_idx;
