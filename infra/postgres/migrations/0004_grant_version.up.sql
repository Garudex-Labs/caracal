-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds refresh_token_version to delegated_grants for optimistic concurrency control.

ALTER TABLE delegated_grants ADD COLUMN IF NOT EXISTS refresh_token_version INT NOT NULL DEFAULT 0;
