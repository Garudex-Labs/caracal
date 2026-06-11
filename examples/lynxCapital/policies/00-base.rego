# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Decision contract, shared rule helpers, and the application bootstrap rule for the
# Lynx Capital policy library.
package caracal.authz

import rego.v1

default result := {
	"decision": "deny",
	"evaluation_status": "complete",
	"determining_policies": [],
	"diagnostics": [{"reason": "no_rule_matched"}],
}

allow_result(policy) := {
	"decision": "allow",
	"evaluation_status": "complete",
	"determining_policies": [{"policy": policy}],
	"diagnostics": [],
}

# The grants entry for the resource under evaluation: its owning application key and
# the scope set each role may hold on it (see the generated 02-grants document).
resource_grant := grants[input.resource.identifier]

# The application key bound to the acting principal (see the 01-bindings document).
principal_app := key if {
	some key, id in app_ids
	id == input.principal.id
}

principal_owns_resource if {
	resource_grant.application == principal_app
}

# An application bootstrapping its session mandate with its client secret: the only
# permitted scope is agent:lifecycle and no agent, delegation, or subject context may
# be attached. The session mandate authorizes coordinator spawns, not resource calls.
bootstrap_exchange if {
	{scope | some scope in input.context.requested_scopes} == {"agent:lifecycle"}
	not input.context.subject_claims
	not input.delegation_edge
	not input.context.agent_session_id
}

result := allow_result("lynx-base-bootstrap") if {
	bootstrap_exchange
	principal_owns_resource
}

# A spawned agent minting its resource mandate: the exchange must reference the
# agent session and its delegation edge, must not carry a subject token, and every
# requested scope must sit inside the edge's narrowed grant.
worker_mint if {
	input.delegation_edge.id
	input.context.agent_session_id
	not input.context.subject_claims
	count(input.context.requested_scopes) > 0
	not "agent:lifecycle" in input.context.requested_scopes
	every scope in input.context.requested_scopes {
		scope in input.delegation_edge.scopes
	}
	customer_confined
}

# The agent's role label must allow every requested scope on this resource.
mint_role_allowed if {
	some role in input.principal.labels
	scopes := resource_grant.roles[role]
	every scope in input.context.requested_scopes {
		scope in scopes
	}
}

# Customer confinement. An agent session spawned for one customer carries a
# customer:<id> label, and that label caps the authority it may mint to the
# customer-record surface: receivables data and the notifications that serve it. A
# customer-labeled agent can never mint treasury, payment-rail, or any other
# non-customer scope, whatever its role would otherwise allow.
customer_scopes := {
	"corebilling:read", "corebilling:post", "corebilling:collect",
	"vela:send", "vela:read",
}

customer_labeled if {
	some label in input.principal.labels
	startswith(label, "customer:")
}

customer_confined if {
	not customer_labeled
}

customer_confined if {
	customer_labeled
	every scope in input.context.requested_scopes {
		scope in customer_scopes
	}
}

# A spawned agent presenting its minted mandate at the Gateway: the mandate must be
# delegation-bound and name this resource in its target audience. The Gateway
# exchange requests no scopes; authority rides in the mandate claims.
mandate_use if {
	input.context.subject_claims.delegation_edge_id != ""
	some target in input.context.subject_claims.target
	target == input.resource.identifier
	not requested_scopes_present
}

requested_scopes_present if {
	count(input.context.requested_scopes) > 0
}

# The presenting agent session must carry a role label granted on this resource.
use_role_allowed if {
	some role in input.principal.labels
	resource_grant.roles[role]
}
