-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Tamper-evident admin audit: per-zone hash chain over admin_audit_events.

ALTER TABLE admin_audit_events
    ADD COLUMN IF NOT EXISTS content_sha256      TEXT,
    ADD COLUMN IF NOT EXISTS prev_content_sha256 TEXT,
    ADD COLUMN IF NOT EXISTS chain_hmac          TEXT,
    ADD COLUMN IF NOT EXISTS chain_seq           BIGINT;

CREATE INDEX IF NOT EXISTS admin_audit_events_chain
    ON admin_audit_events (zone_id, chain_seq DESC);
