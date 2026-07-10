# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Platform-owned decision contract: the signed, versioned authorization brain every zone bundle evaluates.
package caracal.authz

import rego.v1

# The whole contract is deny by default. An adopter zone that supplies no data, or a
# request that matches no allow rule below, resolves here.
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

# A mint allow that may carry a risk and approval gate. When the requested scopes touch
# an approval-gated risk tier the decision stays allow but names a human-approval step-up,
# so STS holds the mandate behind a durable approval an authenticated approver must
# satisfy before it is minted. The classified risk of every requested scope rides in the
# diagnostics for audit and observability whether or not a gate fires.
mint_allow(policy) := {
	"decision": "allow",
	"evaluation_status": "complete",
	"determining_policies": [{"policy": policy}],
	"diagnostics": mint_diagnostics,
}

# Adopter data. grants and app_ids resolve to undefined when a zone omits them, which
# collapses every allow rule to the default deny: a zone with no data authorizes
# nothing. The contract reads these documents; adopters never author the rules below.
resource_grant := data.caracal.authz.grants[input.resource.identifier]

principal_app := key if {
	some key, id in data.caracal.authz.app_ids
	id == input.principal.id
}

principal_owns_resource if {
	resource_grant.application == principal_app
}

# An application bootstrapping its session mandate with its client secret. The only
# permitted scope is agent:lifecycle, and no agent, delegation, or subject context may
# ride along: the mandate authorizes Coordinator Session starts, not resource calls.
bootstrap_exchange if {
	{scope | some scope in input.context.requested_scopes} == {"agent:lifecycle"}
	not input.context.subject_claims
	not input.delegation_edge
	not input.context.agent_session_id
}

# A governed Session minting its resource mandate. The exchange must reference the Session
# session and its delegation edge, must not carry a subject token, and every requested
# scope must sit inside the edge's narrowed grant. This subset check is the delegation
# narrowing floor: removing it would let an agent mint authority its parent never held.
delegated_mint if {
	input.delegation_edge.id
	input.context.agent_session_id
	not input.context.subject_claims
	count(input.context.requested_scopes) > 0
	not "agent:lifecycle" in input.context.requested_scopes
	every scope in input.context.requested_scopes {
		scope in input.delegation_edge.scopes
	}
	confinement_satisfied
}

# The agent's role label must grant every requested scope on this resource.
mint_role_allowed if {
	some role in input.principal.labels
	scopes := resource_grant.roles[role]
	every scope in input.context.requested_scopes {
		scope in scopes
	}
}

# Label confinement. Each adopter confinement rule pairs a label prefix with the scope
# set a principal carrying that label may mint. For every rule whose prefix matches one
# of the principal's labels, every requested scope must fall inside the rule's set. A
# principal matching no prefix is unconfined; a zone with no confinement data is
# vacuously satisfied, so confinement only ever narrows authority.
default confinement_list := []

confinement_list := data.caracal.authz.confinement

confinement_satisfied if {
	every rule in confinement_list {
		confinement_rule_satisfied(rule)
	}
}

confinement_rule_satisfied(rule) if {
	not principal_has_prefix(rule.label_prefix)
}

confinement_rule_satisfied(rule) if {
	principal_has_prefix(rule.label_prefix)
	allowed := {scope | some scope in rule.scopes}
	every scope in input.context.requested_scopes {
		scope in allowed
	}
}

principal_has_prefix(prefix) if {
	some label in input.principal.labels
	startswith(label, prefix)
}

# A workload minting one bound runtime credential during caracal run. The binding a
# zone admin authored in the console is the grant: it names the resource, the scopes,
# and the env var, and STS resolves it server-side so the request wire carries no
# authority. No agent, delegation, or subject context may ride along.
workload_mint if {
	input.principal.type == "Workload"
	input.action.id == "CredentialInjection"
	not input.context.subject_claims
	not input.delegation_edge
	not input.context.agent_session_id
}

# A governed Session presenting its minted mandate at the Gateway. The mandate must be
# delegation-bound and name this resource in its target audience, and the Gateway
# exchange requests no scopes: authority rides in the mandate claims. Per-operation
# scope authority is enforced natively by the Gateway and STS against the resource's
# declared operations, so this rule decides delegation and view binding only.
mandate_use if {
	input.context.subject_claims.delegation_edge_id != ""
	some target in input.context.subject_claims.target
	target == input.resource.identifier
	not requested_scopes_present
}

requested_scopes_present if {
	count(input.context.requested_scopes) > 0
}

# The presenting Session must carry a role label granted on this resource.
use_role_allowed if {
	some role in input.principal.labels
	resource_grant.roles[role]
}

# Deny-only extensibility. An adopter may publish restriction reasons as a data
# document; a non-empty set blocks every allow below. Restrictions can only subtract
# authority, never widen it, so a careless restriction fails closed.
restriction_denied if {
	some _ in data.caracal.authz.restrict
}

# Risk classification and approval gating. An adopter may tag scopes with an opaque
# risk tier and declare which tiers gate minting behind a durable human approval. An
# approval declaration names its tier and may shape the hold: who may decide it
# (operator, subject, or any), how long it lives, and how much approver identity the
# decision record retains. The platform reads tiers as opaque metadata, names the
# classified risk of every requested scope in mint diagnostics, and holds any gated
# mint until an authenticated approver decides it. The tier vocabulary is the
# adopter's; the platform fixes no taxonomy. Like restrictions, an approval
# declaration can only add a gate, never widen authority.
default risk_rules := []

risk_rules := data.caracal.authz.risk

scope_tier(scope) := tier if {
	some rule in risk_rules
	rule.scope == scope
	tier := rule.tier
}

default approval_declarations := []

approval_declarations := data.caracal.authz.approval_tiers

risk_scopes := sort([scope |
	some scope in input.context.requested_scopes
	scope_tier(scope)
])

requested_risk := [{"scope": scope, "tier": scope_tier(scope)} |
	some scope in risk_scopes
]

# A declaration without a tier name can never match a scope, which would silently
# drop the gate it was meant to add. Malformed approval data therefore fails closed:
# scope mints deny until the data document is repaired.
malformed_approval_declarations if {
	some decl in approval_declarations
	not decl.tier
}

matched_declarations := sort({decl |
	some decl in approval_declarations
	some scope in input.context.requested_scopes
	scope_tier(scope) == decl.tier
})

approval_required if count(matched_declarations) > 0

mint_diagnostics := array.concat(step_up_diagnostics, risk_diagnostics)

default step_up_diagnostics := []

step_up_diagnostics := [{"step_up_required": {
	"type": "human_approval",
	"tiers": matched_declarations,
}}] if approval_required

default risk_diagnostics := []

risk_diagnostics := [{"risk": requested_risk}] if count(requested_risk) > 0

# An application minting its session lifecycle mandate.
result := allow_result("caracal-bootstrap") if {
	bootstrap_exchange
	principal_owns_resource
	not restriction_denied
}

# A governed Session minting a resource mandate, narrowed by its Delegation, confined
# by its labels, and bound to a role its grants allow.
result := mint_allow(sprintf("caracal-%s-mint", [principal_app])) if {
	principal_owns_resource
	delegated_mint
	mint_role_allowed
	not restriction_denied
	not malformed_approval_declarations
}

# A workload minting a bound runtime credential. Restrictions and approval-gated risk
# tiers subtract and gate exactly as they do for application mints.
result := mint_allow("caracal-workload-mint") if {
	workload_mint
	not restriction_denied
	not malformed_approval_declarations
}

# A governed Session presenting its minted mandate at the Gateway, bound to a role its
# grants allow on the named resource.
result := allow_result(sprintf("caracal-%s-use", [principal_app])) if {
	principal_owns_resource
	mandate_use
	use_role_allowed
	not restriction_denied
}
