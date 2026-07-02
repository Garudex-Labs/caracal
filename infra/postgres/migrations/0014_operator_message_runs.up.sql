-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Durable Operator message run lifecycle tables for recoverable chat progress.

CREATE TABLE public.operator_message_runs (
    id text NOT NULL,
    zone_id text NOT NULL,
    conversation_id text NOT NULL,
    client_message_id text NOT NULL,
    server_message_turn_id text,
    correlation_id text NOT NULL,
    state text NOT NULL,
    actor_id text,
    provider_id text,
    reason text,
    error_code text,
    error_detail text,
    deadline_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    last_event_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT operator_message_runs_pkey PRIMARY KEY (id),
    CONSTRAINT operator_message_runs_conversation_fkey FOREIGN KEY (conversation_id)
        REFERENCES public.operator_conversations(id) ON DELETE CASCADE,
    CONSTRAINT operator_message_runs_message_turn_fkey FOREIGN KEY (server_message_turn_id)
        REFERENCES public.operator_turns(id) ON DELETE SET NULL,
    CONSTRAINT operator_message_runs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'sending'::text, 'waiting_for_model'::text, 'reasoning'::text, 'waiting_for_tool'::text, 'waiting_for_user_approval'::text, 'executing'::text, 'streaming'::text, 'completed'::text, 'cancelled'::text, 'failed'::text, 'timeout'::text]))),
    CONSTRAINT operator_message_runs_last_event_seq_check CHECK ((last_event_seq >= 0)),
    CONSTRAINT operator_message_runs_completion_check CHECK (((state = ANY (ARRAY['completed'::text, 'cancelled'::text, 'failed'::text, 'timeout'::text])) OR (completed_at IS NULL)))
);

CREATE UNIQUE INDEX operator_message_runs_client_id_idx
    ON public.operator_message_runs (conversation_id, client_message_id);

CREATE UNIQUE INDEX operator_message_runs_correlation_idx
    ON public.operator_message_runs (correlation_id);

CREATE INDEX operator_message_runs_conversation_state_idx
    ON public.operator_message_runs (conversation_id, state, started_at DESC);

CREATE INDEX operator_message_runs_active_idx
    ON public.operator_message_runs (zone_id, conversation_id, updated_at DESC)
    WHERE (state <> ALL (ARRAY['completed'::text, 'cancelled'::text, 'failed'::text, 'timeout'::text]));

CREATE TABLE public.operator_message_run_events (
    id text NOT NULL,
    run_id text NOT NULL,
    zone_id text NOT NULL,
    conversation_id text NOT NULL,
    event_seq bigint NOT NULL,
    state text NOT NULL,
    reason text,
    error_code text,
    error_detail text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_message_run_events_pkey PRIMARY KEY (id),
    CONSTRAINT operator_message_run_events_run_fkey FOREIGN KEY (run_id)
        REFERENCES public.operator_message_runs(id) ON DELETE CASCADE,
    CONSTRAINT operator_message_run_events_conversation_fkey FOREIGN KEY (conversation_id)
        REFERENCES public.operator_conversations(id) ON DELETE CASCADE,
    CONSTRAINT operator_message_run_events_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'sending'::text, 'waiting_for_model'::text, 'reasoning'::text, 'waiting_for_tool'::text, 'waiting_for_user_approval'::text, 'executing'::text, 'streaming'::text, 'completed'::text, 'cancelled'::text, 'failed'::text, 'timeout'::text]))),
    CONSTRAINT operator_message_run_events_event_seq_check CHECK ((event_seq >= 1)),
    CONSTRAINT operator_message_run_events_run_seq_key UNIQUE (run_id, event_seq)
);

CREATE INDEX operator_message_run_events_conversation_idx
    ON public.operator_message_run_events (conversation_id, event_seq);

ALTER TABLE public.operator_message_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_message_run_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY zone_isolation ON public.operator_message_runs USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));

CREATE POLICY zone_isolation ON public.operator_message_run_events USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));

GRANT SELECT,INSERT,UPDATE ON TABLE public.operator_message_runs TO caracalapi;
GRANT SELECT,INSERT ON TABLE public.operator_message_run_events TO caracalapi;