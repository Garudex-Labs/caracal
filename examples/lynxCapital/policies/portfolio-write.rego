# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants write access to a tenant's portfolio resource for principals carrying the
# portfolio-write capability.
package caracal.authz

import rego.v1

allowed_scopes contains "portfolio:write" if {
	portfolio_write_request
}

determining contains "portfolio-write" if {
	portfolio_write_request
}

portfolio_write_request if {
	input.resource.identifier == "resource://portfolio"
	tenant_ok
	has_capability("portfolio-write")
}
