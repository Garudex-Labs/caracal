# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants a tenant auditor read-only visibility across that tenant's portfolio, research,
# and compliance resources. No write or admin scope is ever issued under this policy.
package caracal.authz

import rego.v1

auditor_scopes := {
	"resource://portfolio": {"portfolio:read"},
	"resource://research": {"research:read"},
	"resource://compliance": {"compliance:review"},
}

allowed_scopes contains scope if {
	auditor_request
	some scope in auditor_scopes[input.resource.identifier]
}

determining contains "auditor" if {
	auditor_request
}

auditor_request if {
	lynx_resource
	tenant_ok
	has_capability("auditor")
}
