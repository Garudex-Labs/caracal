-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Partial index for counting live sessions per zone in the dashboard overview.

CREATE INDEX sessions_zone_active_idx ON public.sessions
    USING btree (zone_id, expires_at)
    WHERE (status = 'active'::text);
