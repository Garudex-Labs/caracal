-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses durable model-endpoint reconciliation state; development and CI only.

ALTER TABLE public.operator_ai_providers
    DROP CONSTRAINT IF EXISTS operator_ai_providers_reconciliation_state_check,
    DROP COLUMN IF EXISTS reconciled_at,
    DROP COLUMN IF EXISTS credential_required,
    DROP COLUMN IF EXISTS reconciliation_error_code,
    DROP COLUMN IF EXISTS reconciliation_state;
