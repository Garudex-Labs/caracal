-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes refresh_token_version from delegated_grants.

ALTER TABLE delegated_grants DROP COLUMN IF EXISTS refresh_token_version;
