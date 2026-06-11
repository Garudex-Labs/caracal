-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Drops the admin audit hash-chain columns and index.

DROP INDEX IF EXISTS admin_audit_events_chain;

ALTER TABLE admin_audit_events
    DROP COLUMN IF EXISTS chain_seq,
    DROP COLUMN IF EXISTS chain_hmac,
    DROP COLUMN IF EXISTS prev_content_sha256,
    DROP COLUMN IF EXISTS content_sha256;
