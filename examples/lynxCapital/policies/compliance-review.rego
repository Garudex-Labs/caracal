# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants review access to a tenant's compliance resource for principals carrying the
# compliance-review capability.
package caracal.authz

import rego.v1

allowed_scopes contains "compliance:review" if {
	compliance_review_request
}

determining contains "compliance-review" if {
	compliance_review_request
}

compliance_review_request if {
	input.resource.identifier == "resource://compliance"
	tenant_ok
	has_capability("compliance-review")
}
