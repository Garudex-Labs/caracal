-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes unused provider fields and unsupported provider kinds.

UPDATE providers
SET provider_kind = 'oauth2',
    updated_at = now()
WHERE provider_kind IS NULL OR provider_kind = 'oidc';

UPDATE providers
SET provider_kind = 'oauth2',
    archived_at = COALESCE(archived_at, now()),
    updated_at = now()
WHERE provider_kind = 'workload';

ALTER TABLE providers
    DROP CONSTRAINT IF EXISTS providers_provider_kind_check;

ALTER TABLE providers
    ALTER COLUMN provider_kind SET NOT NULL;

ALTER TABLE providers
    ADD CONSTRAINT providers_provider_kind_check CHECK (provider_kind IN ('oauth2', 'apikey'));

ALTER TABLE providers
    DROP COLUMN IF EXISTS owner_type,
    DROP COLUMN IF EXISTS client_id,
    DROP COLUMN IF EXISTS secret_config_ct,
    DROP COLUMN IF EXISTS secret_config_nonce,
    DROP COLUMN IF EXISTS secret_config_keys;
