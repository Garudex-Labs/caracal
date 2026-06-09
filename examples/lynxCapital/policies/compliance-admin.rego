# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants administrative access to a tenant's compliance resource for principals carrying
# the compliance-admin capability.
package caracal.authz

import rego.v1

allowed_scopes contains "compliance:admin" if {
	compliance_admin_request
}

determining contains "compliance-admin" if {
	compliance_admin_request
}

compliance_admin_request if {
	input.resource.identifier == "resource://compliance"
	tenant_ok
	has_capability("compliance-admin")
}
