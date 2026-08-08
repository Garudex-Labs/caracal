-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses durable Operator message-run token usage; development and CI only.

ALTER TABLE public.operator_message_runs
    DROP CONSTRAINT IF EXISTS operator_message_runs_usage_by_provider_model_check,
    DROP CONSTRAINT IF EXISTS operator_message_runs_output_tokens_check,
    DROP CONSTRAINT IF EXISTS operator_message_runs_input_tokens_check,
    DROP COLUMN IF EXISTS served_model,
    DROP COLUMN IF EXISTS served_provider_id,
    DROP COLUMN IF EXISTS usage_by_provider_model,
    DROP COLUMN IF EXISTS output_tokens,
    DROP COLUMN IF EXISTS input_tokens;
