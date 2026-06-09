# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants break-glass administrative access across a tenant's resources, but only after a
# step-up challenge is satisfied; otherwise it raises a step-up diagnostic.
package caracal.authz

import rego.v1

emergency_scopes := {
	"resource://portfolio": {"portfolio:admin"},
	"resource://research": {"research:write"},
	"resource://compliance": {"compliance:admin"},
}

allowed_scopes contains scope if {
	emergency_request
	input.context.challenge_resolved == true
	some scope in emergency_scopes[input.resource.identifier]
}

determining contains "emergency-access" if {
	emergency_request
	input.context.challenge_resolved == true
}

# When break-glass authority is requested without a satisfied step-up, surface a
# challenge diagnostic so the STS returns interaction_required instead of a flat deny.
diagnostic contains {"step_up_required": "mfa"} if {
	emergency_request
	not input.context.challenge_resolved == true
}

emergency_request if {
	lynx_resource
	tenant_ok
	has_capability("emergency-access")
}
