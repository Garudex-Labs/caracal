-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds the workloads table: launcher identities that bind env names to resource credentials for caracal run.

CREATE TABLE public.workloads (
    id text NOT NULL PRIMARY KEY,
    zone_id text NOT NULL REFERENCES public.zones(id) ON DELETE CASCADE,
    name text NOT NULL,
    secret_hash text NOT NULL,
    bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    updated_at timestamp with time zone
);

CREATE INDEX workloads_zone_idx ON public.workloads USING btree (zone_id, created_at DESC, id DESC);

-- Launch bindings live on workloads; the application-hosted run manifest is retired.
ALTER TABLE public.applications
    DROP COLUMN run_manifest,
    DROP COLUMN run_manifest_updated_by,
    DROP COLUMN run_manifest_updated_at;
