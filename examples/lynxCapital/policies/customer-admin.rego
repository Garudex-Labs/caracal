# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants a tenant administrator full authority across that tenant's portfolio, research,
# and compliance resources, scoped strictly to the administrator's own tenant.
package caracal.authz

import rego.v1

customer_admin_scopes := {
	"resource://portfolio": {"portfolio:read", "portfolio:write", "portfolio:admin"},
	"resource://research": {"research:read", "research:write"},
	"resource://compliance": {"compliance:review", "compliance:admin"},
}

allowed_scopes contains scope if {
	customer_admin_request
	some scope in customer_admin_scopes[input.resource.identifier]
}

determining contains "customer-admin" if {
	customer_admin_request
}

customer_admin_request if {
	lynx_resource
	tenant_ok
	has_capability("customer-admin")
}
