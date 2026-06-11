# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# The two allow decisions shared by every application boundary: delegation-narrowed
# mandate minting and mandate-bound resource use, each confined to the principal's
# own views by the generated grants document.
package caracal.authz

import rego.v1

# A spawned agent minting a resource mandate. The view must belong to the agent's own
# application, every requested scope must sit inside its delegation edge's narrowed
# grant, and its role label must allow those scopes on the view. The application
# boundary lives in the grants data, so one rule decides for every application and
# names the deciding boundary in the decision.
result := allow_result(sprintf("lynx-%s-mint", [principal_app])) if {
	principal_owns_resource
	worker_mint
	mint_role_allowed
}

# A spawned agent presenting its minted mandate at the Gateway. The mandate must name
# this view in its target audience, the view must belong to the presenting agent's
# application, and its role label must be granted on the view.
result := allow_result(sprintf("lynx-%s-use", [principal_app])) if {
	principal_owns_resource
	mandate_use
	use_role_allowed
}
