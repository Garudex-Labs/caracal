-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Reverse the application_id rename for gateway bindings.

ALTER TABLE gateway_resource_bindings RENAME COLUMN application_id TO client_id;
