-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Provisions the current rolling window of monthly audit_events partitions (current month plus the next three) at apply time so a freshly migrated database satisfies the partition window immediately, matching the audit retention worker instead of relying on a static list that rots as the calendar advances.

DO $$
DECLARE
    base_month date := date_trunc('month', now())::date;
    start_month date;
    end_month date;
    part_name text;
    m int;
BEGIN
    FOR m IN 0..3 LOOP
        start_month := base_month + make_interval(months => m);
        end_month := start_month + make_interval(months => 1);
        part_name := format('audit_events_y%sm%s',
                            to_char(start_month, 'YYYY'),
                            to_char(start_month, 'MM'));
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
            part_name, start_month, end_month);
    END LOOP;
END
$$;
