-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses the v0.3.0 schema changes; development and CI only, never invoked by production tooling.

ALTER TABLE public.step_up_challenges DROP COLUMN IF EXISTS subject_anchor;
