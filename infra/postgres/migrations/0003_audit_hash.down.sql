-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes content_sha256 column from audit_events.

ALTER TABLE audit_events DROP COLUMN IF EXISTS content_sha256;
