-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes the active provider-native grant uniqueness guard.

DROP INDEX IF EXISTS provider_grants_active_subject_provider_uidx;
