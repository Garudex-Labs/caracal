-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Single-row operator override for the audit retention window enforced by the audit service.

CREATE TABLE public.audit_retention (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    retention_days integer NOT NULL CHECK (retention_days >= 1),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
