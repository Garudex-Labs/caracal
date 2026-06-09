# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants write access to a tenant's research resource for principals carrying the
# research-write capability.
package caracal.authz

import rego.v1

allowed_scopes contains "research:write" if {
	research_write_request
}

determining contains "research-write" if {
	research_write_request
}

research_write_request if {
	input.resource.identifier == "resource://research"
	tenant_ok
	has_capability("research-write")
}
