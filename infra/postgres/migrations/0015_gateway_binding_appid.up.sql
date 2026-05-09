-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Gateway bindings: client_id stores the bare application id; zone identity is
-- the separate zone_id column. STS receives zone_id and application_id as
-- distinct form parameters, eliminating positional parsing of a colon-delimited
-- client_id.

UPDATE gateway_resource_bindings
SET client_id = split_part(client_id, ':', 2)
WHERE position(':' IN client_id) > 0;

ALTER TABLE gateway_resource_bindings RENAME COLUMN client_id TO application_id;
