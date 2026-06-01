-- Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
-- Caracal, a product of Garudex Labs
--
-- Removes Coordinator resource delegation ownership grants.

REVOKE SELECT ON resources, gateway_resource_bindings FROM caracalCoordinator;
