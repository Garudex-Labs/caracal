-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts the approver_subject_id column on step_up_challenges.

DROP INDEX IF EXISTS step_up_challenges_approver;
ALTER TABLE step_up_challenges DROP COLUMN IF EXISTS approver_subject_id;
