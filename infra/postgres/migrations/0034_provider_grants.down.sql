-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Restores provider-native token columns to delegated grants for rollback.

ALTER TABLE delegated_grants
    ADD COLUMN IF NOT EXISTS provider_id TEXT,
    ADD COLUMN IF NOT EXISTS access_token_ct BYTEA,
    ADD COLUMN IF NOT EXISTS refresh_token_ct BYTEA,
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refresh_token_version INT NOT NULL DEFAULT 0;

UPDATE delegated_grants d
SET provider_id = pg.provider_id,
    access_token_ct = pg.access_token_ct,
    refresh_token_ct = pg.refresh_token_ct,
    expires_at = pg.expires_at,
    refreshed_at = pg.refreshed_at,
    refresh_token_version = pg.refresh_token_version,
    updated_at = now()
FROM provider_grants pg
WHERE d.id = pg.id;

ALTER TABLE delegated_grants
    ADD CONSTRAINT delegated_grants_zone_provider_fk
        FOREIGN KEY (zone_id, provider_id) REFERENCES providers(zone_id, id);

DROP TABLE IF EXISTS provider_grants;
