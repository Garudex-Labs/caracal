-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds a per-conversation autopilot engage flag to the Operator so a conversation can opt into Caracal-governed auto-approval of low-risk changes; the policy of what may be auto-approved is set in Caracal, never by the conversation.

ALTER TABLE public.operator_conversations
    ADD COLUMN autopilot boolean DEFAULT false NOT NULL;
