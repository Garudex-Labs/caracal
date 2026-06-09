# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Grants a delegated advisor agent only the scopes carried on its delegation edge, so a
# human advisor's agent can never exceed the authority the advisor handed it.
package caracal.authz

import rego.v1

allowed_scopes contains scope if {
	delegated_advisor_request
	some scope in advisable_scopes
	scope in {edge_scope | some edge_scope in input.delegation_edge.scopes}
}

determining contains "delegated-advisor" if {
	delegated_advisor_request
}

# The narrow set of read scopes an advisor's agent may ever exercise. The delegation
# edge narrows further; the intersection above is what the agent actually receives.
advisable_scopes := {"portfolio:read", "research:read"}

delegated_advisor_request if {
	lynx_resource
	tenant_ok
	has_capability("delegated-advisor")
	input.delegation_edge.id
}
