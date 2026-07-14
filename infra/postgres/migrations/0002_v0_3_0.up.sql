-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Schema changes for the v0.3.0 release line; amended in place until v0.3.0 ships stable.

-- Approval holds anchor to the federated Subject the gated execution acts for;
-- the STS reserves subject-plane decisions on an anchored hold for that exact
-- Subject. Rows created before this column exists stay decidable by any of the
-- application's federated end users, matching their issuance-time contract.
ALTER TABLE public.step_up_challenges ADD COLUMN subject_anchor text;
