-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Enforces bounded lifetimes for dynamically registered application identities.

UPDATE applications
SET expires_at = LEAST(COALESCE(expires_at, now() + INTERVAL '1 hour'), now() + INTERVAL '1 hour')
WHERE registration_method = 'dcr'
  AND archived_at IS NULL;

ALTER TABLE applications
    ADD CONSTRAINT applications_dcr_expires_at_required
    CHECK (registration_method <> 'dcr' OR expires_at IS NOT NULL);
