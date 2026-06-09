# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Base decision document that aggregates the Lynx Capital scenario policies into the
# Caracal token-exchange result and enforces per-tenant isolation.
package caracal.authz

import rego.v1

# The token-exchange result the STS evaluates. decision, determining_policies, and
# diagnostics are computed below from the scenario policies in this package.
result := {
	"decision": decision,
	"evaluation_status": "complete",
	"determining_policies": determining_policies,
	"diagnostics": diagnostics,
}

# An exchange is allowed when it is a token exchange, requests at least one scope, and
# every requested scope is permitted by a scenario policy for this principal, resource,
# and tenant. allowed_scopes is a partial set contributed by the scenario policies.
default decision := "deny"

decision := "allow" if {
	input.action.id == "TokenExchange"
	count(input.context.requested_scopes) > 0
	every scope in input.context.requested_scopes {
		scope in allowed_scopes
	}
}

# Name the scenario policies that determined an allow; empty on deny.
default determining_policies := []

determining_policies := [{"policy": name} | some name in determining] if {
	decision == "allow"
}

# Diagnostics raised by scenario policies (for example a required step-up challenge).
diagnostics := [entry | some entry in diagnostic]

# The tenant the request acts for: the delegated subject's tenant when a subject is
# present, otherwise the acting credential's own tenant (a per-tenant DCR application).
effective_tenant := tenant if {
	tenant := input.context.subject_claims.tenant_id
}

effective_tenant := tenant if {
	not input.context.subject_claims.tenant_id
	tenant := input.context.actor_claims.tenant_id
}

# Tenant isolation: the principal must carry a `tenant:<id>` label that matches the
# tenant the request acts for. A label minted for one tenant can never satisfy a
# request whose subject or credential belongs to another tenant.
tenant_ok if {
	some label in input.principal.labels
	label == sprintf("tenant:%s", [effective_tenant])
}

# A capability label set on the agent session at spawn time, e.g. "portfolio-write".
has_capability(capability) if {
	some label in input.principal.labels
	label == capability
}

# A Lynx Capital domain resource.
lynx_resource if {
	input.resource.identifier in {
		"resource://portfolio",
		"resource://research",
		"resource://compliance",
	}
}
