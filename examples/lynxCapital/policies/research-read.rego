# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants read access to a tenant's research resource for principals carrying the
# research-read capability.
package caracal.authz

import rego.v1

allowed_scopes contains "research:read" if {
	research_read_request
}

determining contains "research-read" if {
	research_read_request
}

research_read_request if {
	input.resource.identifier == "resource://research"
	tenant_ok
	has_capability("research-read")
}
