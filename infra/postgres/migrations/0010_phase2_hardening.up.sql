-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Phase 2 control-plane hardening: tenant-boundary FKs and soft-delete columns.

ALTER TABLE delegated_grants
    ADD CONSTRAINT delegated_grants_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id);

ALTER TABLE sessions
    ADD CONSTRAINT sessions_zone_id_fkey
    FOREIGN KEY (zone_id) REFERENCES zones(id);

ALTER TABLE delegated_grants
    ADD CONSTRAINT delegated_grants_resource_id_fkey
    FOREIGN KEY (resource_id) REFERENCES resources(id);

ALTER TABLE zones      ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE providers  ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE resources  ADD COLUMN archived_at TIMESTAMPTZ;

CREATE INDEX zones_active_idx     ON zones(id)     WHERE archived_at IS NULL;
CREATE INDEX providers_active_idx ON providers(id) WHERE archived_at IS NULL;
CREATE INDEX resources_active_idx ON resources(id) WHERE archived_at IS NULL;
