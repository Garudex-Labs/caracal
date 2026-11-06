-- Copyright (C) 2026 Garudex Labs. All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Chain writers read DESC NULLS LAST while holding a per-zone lock. The old
-- DESC indexes defaulted to NULLS FIRST and forced a ledger-wide sort on every
-- append. Keep the original index too: its reverse scan serves Search's
-- ASC NULLS LAST ordering, whereas the head requires DESC NULLS LAST.
-- Partition indexes are built transactionally by the migration runner, so bound
-- lock acquisition to avoid stalling a busy cluster indefinitely.
SET LOCAL lock_timeout = '10s';

CREATE INDEX audit_events_zone_chain_head ON public.audit_events (zone_id, chain_seq DESC NULLS LAST);


-- STS recursive revocation/lineage and the parent foreign-key checks must not
-- scan the entire authority table once per parent. parent_id first also serves
-- FK checks that do not carry a zone predicate; recursive STS queries carry both.
CREATE INDEX IF NOT EXISTS authority_records_parent_zone_idx
    ON public.authority_records (parent_id, zone_id)
    WHERE parent_id IS NOT NULL;
