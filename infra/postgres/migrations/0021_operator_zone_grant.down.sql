-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts the per-zone Operator administration grant.

ALTER TABLE public.zones DROP COLUMN operator_governed;
