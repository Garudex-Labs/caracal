-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverses the consolidated baseline by dropping all control-plane objects and service roles; development and CI only, never invoked by production tooling.

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

DROP ROLE IF EXISTS caracalapi;
DROP ROLE IF EXISTS caracalaudit;
DROP ROLE IF EXISTS caracalcoordinator;
DROP ROLE IF EXISTS caracalgateway;
DROP ROLE IF EXISTS caracalsts;
