-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Gives each Operator conversation a per-zone sequential number so a chat has a stable, human-readable id that can address it in the console URL.

ALTER TABLE public.operator_conversations
    ADD COLUMN IF NOT EXISTS number bigint;

-- Backfill existing conversations with a per-zone running number in creation order, so a
-- deployment upgraded in place keeps every chat addressable from the first numbered build.
WITH ordered AS (
    SELECT c.id,
           COALESCE((SELECT MAX(m.number) FROM public.operator_conversations m WHERE m.zone_id = c.zone_id), 0)
               + row_number() OVER (PARTITION BY c.zone_id ORDER BY c.created_at, c.id) AS rn
    FROM public.operator_conversations c
    WHERE c.number IS NULL
)
UPDATE public.operator_conversations c
SET number = ordered.rn
FROM ordered
WHERE c.id = ordered.id;

CREATE UNIQUE INDEX IF NOT EXISTS operator_conversations_zone_number_idx
    ON public.operator_conversations (zone_id, number);
