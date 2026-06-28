-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds the Operator's model-provider registry: non-secret metadata for each governed LLM provider and its models, where the upstream key lives only in the sealed Caracal provider and never in this table.

CREATE TABLE public.operator_ai_providers (
    slug text NOT NULL,
    label text NOT NULL,
    base_url text NOT NULL,
    models jsonb DEFAULT '[]'::jsonb NOT NULL,
    context_window integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operator_ai_providers_pkey PRIMARY KEY (slug),
    CONSTRAINT operator_ai_providers_slug_check CHECK ((slug ~ '^[a-z0-9_]{1,32}$')),
    CONSTRAINT operator_ai_providers_context_window_check CHECK ((context_window >= 0))
);

CREATE INDEX operator_ai_providers_order_idx
    ON public.operator_ai_providers (sort_order, slug);
