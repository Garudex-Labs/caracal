-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Drops the rolling-window audit_events partitions provisioned beyond the baseline's static set; development and CI only, never invoked by production tooling.

DO $$
DECLARE
    base_month date := date_trunc('month', now())::date;
    start_month date;
    part_name text;
    m int;
BEGIN
    FOR m IN 0..3 LOOP
        start_month := base_month + make_interval(months => m);
        IF start_month <= date '2026-09-01' THEN
            CONTINUE;
        END IF;
        part_name := format('audit_events_y%sm%s',
                            to_char(start_month, 'YYYY'),
                            to_char(start_month, 'MM'));
        EXECUTE format('DROP TABLE IF EXISTS public.%I', part_name);
    END LOOP;
END
$$;
