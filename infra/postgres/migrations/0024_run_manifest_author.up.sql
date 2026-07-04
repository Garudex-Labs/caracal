-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds authorship stamping for the run manifest so the console shows which operator configured launch bindings.

ALTER TABLE public.applications
    ADD COLUMN run_manifest_updated_by text,
    ADD COLUMN run_manifest_updated_at timestamptz;
