-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Keeps one active provider-native delegated credential per user-resource-provider binding.

WITH ranked AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY zone_id, user_id, resource_id, provider_id
            ORDER BY created_at DESC, id DESC
        ) AS rank
    FROM provider_grants
    WHERE status = 'active'
)
UPDATE provider_grants pg
SET status = 'revoked',
    updated_at = now()
FROM ranked r
WHERE pg.id = r.id
  AND r.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS provider_grants_active_subject_provider_uidx
    ON provider_grants(zone_id, user_id, resource_id, provider_id)
    WHERE status = 'active';
