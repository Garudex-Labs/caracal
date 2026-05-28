-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes the DCR lifetime enforcement constraint.

ALTER TABLE applications
    DROP CONSTRAINT IF EXISTS applications_dcr_expires_at_required;
