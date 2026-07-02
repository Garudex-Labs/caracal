-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds the Operator plan credential vault: sealed, short-lived per-step credentials pasted through the console's secure prompt, never written to the conversation ledger.

CREATE TABLE public.operator_plan_secrets (
    conversation_id text NOT NULL,
    zone_id text NOT NULL,
    plan_seq bigint NOT NULL,
    step_id text NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    secret_keys text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT operator_plan_secrets_pkey PRIMARY KEY (conversation_id, plan_seq, step_id),
    CONSTRAINT operator_plan_secrets_conversation_fkey FOREIGN KEY (conversation_id)
        REFERENCES public.operator_conversations(id) ON DELETE CASCADE,
    CONSTRAINT operator_plan_secrets_plan_seq_check CHECK ((plan_seq >= 1))
);

ALTER TABLE public.operator_plan_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY zone_isolation ON public.operator_plan_secrets USING (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true)))) WITH CHECK (((current_setting('caracal.zone_id'::text, true) = '*'::text) OR (zone_id = current_setting('caracal.zone_id'::text, true))));

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.operator_plan_secrets TO caracalapi;
