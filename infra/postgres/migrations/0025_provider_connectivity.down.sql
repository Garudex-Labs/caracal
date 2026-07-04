-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts the connectivity check state on providers.

ALTER TABLE public.providers DROP COLUMN connectivity_failed_at;
