-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes run manifest authorship stamping from applications.

ALTER TABLE public.applications
    DROP COLUMN run_manifest_updated_by,
    DROP COLUMN run_manifest_updated_at;
