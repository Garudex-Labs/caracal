-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Restores the application-hosted run manifest columns and removes the workloads table.

ALTER TABLE public.applications
    ADD COLUMN run_manifest jsonb,
    ADD COLUMN run_manifest_updated_by text,
    ADD COLUMN run_manifest_updated_at timestamptz;

DROP TABLE public.workloads;
