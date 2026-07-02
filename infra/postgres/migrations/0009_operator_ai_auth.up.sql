-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds key-placement metadata to the Operator model-provider registry so an upstream's sealed key is injected where it expects it, without per-vendor handling.

ALTER TABLE public.operator_ai_providers
    ADD COLUMN auth_config jsonb DEFAULT '{}'::jsonb NOT NULL;
