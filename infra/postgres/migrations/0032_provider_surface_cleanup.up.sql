-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes unused provider fields and normalizes provider kinds to real auth modes.

ALTER TABLE providers
    DROP CONSTRAINT IF EXISTS providers_provider_kind_check;

UPDATE providers
SET provider_kind = 'oauth2_authorization_code',
    updated_at = now()
WHERE provider_kind IS NULL OR provider_kind = 'oidc';

UPDATE providers
SET provider_kind = 'oauth2_authorization_code',
    archived_at = COALESCE(archived_at, now()),
    updated_at = now()
WHERE provider_kind = 'workload';

UPDATE providers
SET provider_kind = 'api_key',
    updated_at = now()
WHERE provider_kind = 'apikey';

ALTER TABLE providers
    ALTER COLUMN provider_kind SET NOT NULL;

ALTER TABLE providers
    ADD CONSTRAINT providers_provider_kind_check CHECK (
        provider_kind IN ('oauth2_authorization_code', 'oauth2_client_credentials', 'api_key', 'bearer_token')
    );

ALTER TABLE providers
    DROP COLUMN IF EXISTS owner_type,
    DROP COLUMN IF EXISTS client_id;
