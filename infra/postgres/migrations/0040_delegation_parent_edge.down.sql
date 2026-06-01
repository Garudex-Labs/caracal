-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes downstream delegation parent edge provenance.

DROP INDEX IF EXISTS delegation_edges_zone_id_parent_edge_id_idx;

ALTER TABLE delegation_edges
    DROP COLUMN IF EXISTS parent_edge_id;
