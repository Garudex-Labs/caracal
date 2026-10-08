-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Makes model-endpoint reconciliation durable without storing plaintext credentials.

ALTER TABLE public.operator_ai_providers
    ADD COLUMN reconciliation_state text DEFAULT 'ready'::text NOT NULL,
    ADD COLUMN reconciliation_error_code text,
    ADD COLUMN credential_required boolean DEFAULT false NOT NULL,
    ADD COLUMN reconciled_at timestamp with time zone;

ALTER TABLE public.operator_ai_providers
    ADD CONSTRAINT operator_ai_providers_reconciliation_state_check
        CHECK (reconciliation_state = ANY (ARRAY['ready'::text, 'pending'::text, 'error'::text, 'deleting'::text])) NOT VALID;

ALTER TABLE public.operator_ai_providers
    VALIDATE CONSTRAINT operator_ai_providers_reconciliation_state_check;
