-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Separates provider-native delegated credentials from Caracal access grants.

CREATE TABLE IF NOT EXISTS provider_grants (
    id                    TEXT PRIMARY KEY,
    zone_id               TEXT NOT NULL,
    user_id               TEXT NOT NULL,
    resource_id           TEXT NOT NULL,
    provider_id           TEXT NOT NULL,
    scopes                TEXT[] NOT NULL DEFAULT '{}',
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
    access_token_ct       BYTEA,
    refresh_token_ct      BYTEA,
    expires_at            TIMESTAMPTZ,
    refreshed_at          TIMESTAMPTZ,
    refresh_token_version INT NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_grants_zone_resource_fk
        FOREIGN KEY (zone_id, resource_id) REFERENCES resources(zone_id, id),
    CONSTRAINT provider_grants_zone_provider_fk
        FOREIGN KEY (zone_id, provider_id) REFERENCES providers(zone_id, id)
);

INSERT INTO provider_grants (
    id,
    zone_id,
    user_id,
    resource_id,
    provider_id,
    scopes,
    status,
    access_token_ct,
    refresh_token_ct,
    expires_at,
    refreshed_at,
    refresh_token_version,
    created_at,
    updated_at
)
SELECT
    id,
    zone_id,
    user_id,
    resource_id,
    provider_id,
    scopes,
    status,
    access_token_ct,
    refresh_token_ct,
    expires_at,
    refreshed_at,
    refresh_token_version,
    created_at,
    updated_at
FROM delegated_grants
WHERE provider_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS provider_grants_zone_user_resource_status_idx
    ON provider_grants(zone_id, user_id, resource_id, status);

CREATE INDEX IF NOT EXISTS provider_grants_zone_provider_status_idx
    ON provider_grants(zone_id, provider_id, status);

GRANT SELECT, INSERT, UPDATE ON provider_grants TO caracalSts;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_grants TO caracalApi;

ALTER TABLE provider_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY zone_isolation ON provider_grants
USING (
    current_setting('caracal.zone_id', true) = '*'
    OR zone_id = current_setting('caracal.zone_id', true)
)
WITH CHECK (
    current_setting('caracal.zone_id', true) = '*'
    OR zone_id = current_setting('caracal.zone_id', true)
);

ALTER TABLE delegated_grants
    DROP CONSTRAINT IF EXISTS delegated_grants_zone_provider_fk,
    DROP COLUMN IF EXISTS provider_id,
    DROP COLUMN IF EXISTS access_token_ct,
    DROP COLUMN IF EXISTS refresh_token_ct,
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS refreshed_at,
    DROP COLUMN IF EXISTS refresh_token_version;
