-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Adds the explicit per-zone Operator administration grant the control plane's zone-scope boundary enforces.

ALTER TABLE public.zones
    ADD COLUMN operator_governed boolean DEFAULT false NOT NULL;
