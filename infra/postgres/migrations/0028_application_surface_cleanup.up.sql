-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes unused Application consent configuration from the production schema.

ALTER TABLE applications
    DROP COLUMN IF EXISTS consent;

ALTER TABLE applications
    DROP CONSTRAINT IF EXISTS applications_credential_type_check;

ALTER TABLE applications
    ADD CONSTRAINT applications_credential_type_check CHECK (credential_type = 'token') NOT VALID;
