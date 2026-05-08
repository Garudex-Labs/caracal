-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Provider secret-bearing config moves to a sealed envelope; config_json keeps only public metadata.

ALTER TABLE providers
    ADD COLUMN secret_config_ct    BYTEA,
    ADD COLUMN secret_config_nonce BYTEA,
    ADD COLUMN secret_config_keys  TEXT[] NOT NULL DEFAULT '{}';
