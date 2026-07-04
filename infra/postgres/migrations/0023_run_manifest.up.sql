-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds the server-side run manifest that maps env names to resources for caracal run launches.

ALTER TABLE public.applications
    ADD COLUMN run_manifest jsonb;
