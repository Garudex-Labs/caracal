-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Anchors approval holds to the federated Subject the gated execution acts for.

-- The STS reserves subject-plane decisions on an anchored hold for that exact
-- Subject. Rows created before this column exists stay decidable by any of the
-- application's federated end users, matching their issuance-time contract.
ALTER TABLE public.step_up_challenges ADD COLUMN subject_anchor text;
