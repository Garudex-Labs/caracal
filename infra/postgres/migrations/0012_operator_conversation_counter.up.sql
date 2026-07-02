-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Allocates each Operator conversation number from a durable per-zone counter so a number is consumed once and never reused, even after its conversation is deleted.

CREATE TABLE IF NOT EXISTS public.operator_conversation_counters (
    zone_id     text PRIMARY KEY,
    next_number bigint NOT NULL
);

-- Seed each zone's counter from the highest number already in use so existing chats keep their
-- numbers and the next allocation continues above them instead of colliding.
INSERT INTO public.operator_conversation_counters (zone_id, next_number)
SELECT zone_id, MAX(number)
FROM public.operator_conversations
WHERE number IS NOT NULL
GROUP BY zone_id
ON CONFLICT (zone_id) DO NOTHING;
