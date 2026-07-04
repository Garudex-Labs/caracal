-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Connectivity check state on providers so unverified credential sources stay visibly flagged.

ALTER TABLE public.providers ADD COLUMN connectivity_failed_at timestamp with time zone;
