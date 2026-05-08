-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Drops the sealed-secret columns added in 0013_provider_secret_config.

ALTER TABLE providers
    DROP COLUMN IF EXISTS secret_config_ct,
    DROP COLUMN IF EXISTS secret_config_nonce,
    DROP COLUMN IF EXISTS secret_config_keys;
