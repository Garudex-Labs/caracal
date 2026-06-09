# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants read access to a tenant's portfolio resource for principals carrying the
# portfolio-read capability.
package caracal.authz

import rego.v1

allowed_scopes contains "portfolio:read" if {
	portfolio_read_request
}

determining contains "portfolio-read" if {
	portfolio_read_request
}

portfolio_read_request if {
	input.resource.identifier == "resource://portfolio"
	tenant_ok
	has_capability("portfolio-read")
}
