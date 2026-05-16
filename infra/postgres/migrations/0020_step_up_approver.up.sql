-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Records the subject who satisfied a step-up challenge so the approver
-- can be required to differ from the requesting session's subject.

ALTER TABLE step_up_challenges
    ADD COLUMN IF NOT EXISTS approver_subject_id TEXT;

CREATE INDEX IF NOT EXISTS step_up_challenges_approver
    ON step_up_challenges (approver_subject_id)
    WHERE approver_subject_id IS NOT NULL;
