-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverts durable revocation metadata and session audit indexes.

DROP INDEX IF EXISTS public.audit_events_session_idx;
DROP INDEX IF EXISTS public.sessions_zone_subject_idx;
DROP INDEX IF EXISTS public.sessions_zone_created_idx;

ALTER TABLE public.sessions DROP COLUMN IF EXISTS revoked_reason;
ALTER TABLE public.sessions DROP COLUMN IF EXISTS revoked_at;
