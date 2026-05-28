-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Restores Application consent configuration for rollback.

ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS consent TEXT NOT NULL DEFAULT 'required' CHECK (consent IN ('implicit', 'required'));

ALTER TABLE applications
    DROP CONSTRAINT IF EXISTS applications_credential_type_check;

ALTER TABLE applications
    ADD CONSTRAINT applications_credential_type_check CHECK (credential_type IN ('token', 'password', 'public-key', 'url', 'public')) NOT VALID;
