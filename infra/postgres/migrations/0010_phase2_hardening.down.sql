-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Phase 2 control-plane hardening rollback.

DROP INDEX IF EXISTS resources_active_idx;
DROP INDEX IF EXISTS providers_active_idx;
DROP INDEX IF EXISTS zones_active_idx;

ALTER TABLE resources  DROP COLUMN IF EXISTS archived_at;
ALTER TABLE providers  DROP COLUMN IF EXISTS archived_at;
ALTER TABLE zones      DROP COLUMN IF EXISTS archived_at;

ALTER TABLE delegated_grants DROP CONSTRAINT IF EXISTS delegated_grants_resource_id_fkey;
ALTER TABLE sessions         DROP CONSTRAINT IF EXISTS sessions_zone_id_fkey;
ALTER TABLE delegated_grants DROP CONSTRAINT IF EXISTS delegated_grants_zone_id_fkey;
