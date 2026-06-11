# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Application bindings: the control-plane application ids each policy keys on.
# scripts/provision.py authors this document with the created application UUIDs;
# the committed values are placeholders for offline policy tests.
package caracal.authz

import rego.v1

app_ids := {
	"operations": "app-operations",
	"intake": "app-intake",
	"ledger": "app-ledger",
	"compliance": "app-compliance",
	"treasury": "app-treasury",
	"payments": "app-payments",
	"audit": "app-audit",
}

# Bindings are data for the shared rules in 00-base; this document never decides on
# its own. The inert rule below satisfies the platform's policy authoring contract,
# which requires every authored policy to define a result rule.
result := allow_result("lynx-bindings") if {
	false
}
