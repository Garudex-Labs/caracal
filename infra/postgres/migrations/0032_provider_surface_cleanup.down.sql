-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Restores legacy provider columns and provider-kind values for rollback.

ALTER TABLE providers
    ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'customer',
    ADD COLUMN IF NOT EXISTS client_id TEXT;

ALTER TABLE providers
    DROP CONSTRAINT IF EXISTS providers_provider_kind_check;

UPDATE providers
SET provider_kind = 'oauth2',
    updated_at = now()
WHERE provider_kind IN ('oauth2_authorization_code', 'oauth2_client_credentials');

UPDATE providers
SET provider_kind = 'apikey',
    updated_at = now()
WHERE provider_kind IN ('api_key', 'bearer_token');

ALTER TABLE providers
    ALTER COLUMN provider_kind DROP NOT NULL;

ALTER TABLE providers
    ADD CONSTRAINT providers_provider_kind_check CHECK (provider_kind IS NULL OR provider_kind IN ('oauth2', 'oidc', 'apikey', 'workload')) NOT VALID;
