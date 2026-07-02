-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses the Operator model-provider key-placement column; development and CI only, never invoked by production tooling.

ALTER TABLE public.operator_ai_providers
    DROP COLUMN IF EXISTS auth_config;
