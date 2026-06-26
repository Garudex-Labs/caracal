-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds the Caracal Operator conversation ledger: zone-scoped conversations and an append-only turn log that records every operator message, plan, approval, rejection, execution, and error.

CREATE TABLE public.operator_conversations (
    id text NOT NULL,
    zone_id text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by text NOT NULL,
    next_seq bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT operator_conversations_pkey PRIMARY KEY (id),
    CONSTRAINT operator_conversations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT operator_conversations_next_seq_check CHECK ((next_seq >= 1))
);

CREATE INDEX operator_conversations_zone_keyset_idx
    ON public.operator_conversations (zone_id, created_at DESC, id DESC)
    WHERE (archived_at IS NULL);

CREATE TABLE public.operator_turns (
    id text NOT NULL,
    conversation_id text NOT NULL,
    zone_id text NOT NULL,
    seq bigint NOT NULL,
    role text NOT NULL,
    kind text NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id text,
    client_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_turns_pkey PRIMARY KEY (id),
    CONSTRAINT operator_turns_conversation_fkey FOREIGN KEY (conversation_id)
        REFERENCES public.operator_conversations(id) ON DELETE CASCADE,
    CONSTRAINT operator_turns_role_check CHECK ((role = ANY (ARRAY['user'::text, 'operator'::text, 'system'::text]))),
    CONSTRAINT operator_turns_kind_check CHECK ((kind = ANY (ARRAY['message'::text, 'plan'::text, 'approval'::text, 'rejection'::text, 'execution'::text, 'error'::text, 'note'::text]))),
    CONSTRAINT operator_turns_seq_check CHECK ((seq >= 1)),
    CONSTRAINT operator_turns_conversation_seq_key UNIQUE (conversation_id, seq)
);

CREATE INDEX operator_turns_conversation_seq_idx
    ON public.operator_turns (conversation_id, seq);

CREATE UNIQUE INDEX operator_turns_idempotency_idx
    ON public.operator_turns (conversation_id, client_token)
    WHERE (client_token IS NOT NULL);

ALTER TABLE public.operator_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_turns ENABLE ROW LEVEL SECURITY;

CREATE POLICY zone_isolation ON public.operator_conversations USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));

CREATE POLICY zone_isolation ON public.operator_turns USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));

GRANT SELECT,INSERT,UPDATE ON TABLE public.operator_conversations TO caracalapi;
GRANT SELECT,INSERT ON TABLE public.operator_turns TO caracalapi;
