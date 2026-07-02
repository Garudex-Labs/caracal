-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds the Caracal Operator durable zone memory: a zone-scoped store of governed changes already applied, persisted across conversations so a new conversation recalls a zone's established shape.

CREATE TABLE public.operator_zone_memory (
    id text NOT NULL,
    zone_id text NOT NULL,
    conversation_id text,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_zone_memory_pkey PRIMARY KEY (id),
    CONSTRAINT operator_zone_memory_text_check CHECK ((char_length(text) >= 1 AND char_length(text) <= 2000))
);

CREATE INDEX operator_zone_memory_recall_idx
    ON public.operator_zone_memory (zone_id, created_at DESC, id DESC);

ALTER TABLE public.operator_zone_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY zone_isolation ON public.operator_zone_memory USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));

GRANT SELECT,INSERT ON TABLE public.operator_zone_memory TO caracalapi;
