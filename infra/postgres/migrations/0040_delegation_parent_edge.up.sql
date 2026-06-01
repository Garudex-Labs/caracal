-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Records the parent delegation edge that authorizes downstream delegation.

ALTER TABLE delegation_edges
    ADD COLUMN parent_edge_id TEXT REFERENCES delegation_edges(id) ON DELETE SET NULL;

CREATE INDEX ON delegation_edges(zone_id, parent_edge_id) WHERE parent_edge_id IS NOT NULL;
