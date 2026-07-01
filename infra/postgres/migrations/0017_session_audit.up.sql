-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Durable revocation metadata and lookup indexes for subject session audit.

ALTER TABLE public.sessions ADD COLUMN revoked_at timestamp with time zone;
ALTER TABLE public.sessions ADD COLUMN revoked_reason text;

CREATE INDEX sessions_zone_created_idx ON public.sessions USING btree (zone_id, created_at DESC, id DESC);
CREATE INDEX sessions_zone_subject_idx ON public.sessions USING btree (zone_id, subject_id);

CREATE INDEX audit_events_session_idx ON public.audit_events
    USING btree (((metadata_json ->> 'session_id'::text)))
    WHERE (metadata_json ? 'session_id'::text);
