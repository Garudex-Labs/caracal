-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes the server-side run manifest column from applications.

ALTER TABLE public.applications
    DROP COLUMN run_manifest;
