# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Decision tests for the Lynx Capital policy library, runnable with `opa test policies/`.
package caracal.authz_test

import data.caracal.authz
import rego.v1

# A token-exchange input for tenant `tenant`, principal capabilities `caps`, targeting
# `resource` and requesting `scopes`, acting on behalf of subject tenant `subject`.
request(tenant, caps, resource, scopes, subject) := {
	"action": {"id": "TokenExchange"},
	"principal": {
		"id": "app_test",
		"registration_method": "managed",
		"labels": array.concat([sprintf("tenant:%s", [tenant])], caps),
	},
	"resource": {"identifier": resource},
	"context": {
		"requested_scopes": scopes,
		"subject_claims": {"tenant_id": subject},
	},
}

test_portfolio_read_allows_for_own_tenant if {
	authz.result.decision == "allow" with input as request(
		"aurora", ["portfolio-read"], "resource://portfolio", ["portfolio:read"], "aurora",
	)
}

test_portfolio_read_capability_cannot_write if {
	authz.result.decision == "deny" with input as request(
		"aurora", ["portfolio-read"], "resource://portfolio", ["portfolio:write"], "aurora",
	)
}

test_portfolio_write_allows if {
	authz.result.decision == "allow" with input as request(
		"aurora", ["portfolio-write"], "resource://portfolio", ["portfolio:write"], "aurora",
	)
}

test_portfolio_admin_allows if {
	authz.result.decision == "allow" with input as request(
		"aurora", ["portfolio-admin"], "resource://portfolio", ["portfolio:admin"], "aurora",
	)
}

test_research_read_and_write if {
	authz.result.decision == "allow" with input as request(
		"borealis", ["research-read", "research-write"], "resource://research",
		["research:read", "research:write"], "borealis",
	)
}

test_compliance_review_allows if {
	authz.result.decision == "allow" with input as request(
		"aurora", ["compliance-review"], "resource://compliance", ["compliance:review"], "aurora",
	)
}

test_compliance_admin_allows if {
	authz.result.decision == "allow" with input as request(
		"aurora", ["compliance-admin"], "resource://compliance", ["compliance:admin"], "aurora",
	)
}

# Tenant isolation: an agent labelled for aurora can never act for a borealis subject.
test_cross_tenant_is_denied if {
	authz.result.decision == "deny" with input as request(
		"aurora", ["portfolio-read"], "resource://portfolio", ["portfolio:read"], "borealis",
	)
}

# A portfolio capability does not leak into another tenant's research resource.
test_capability_does_not_cross_resource if {
	authz.result.decision == "deny" with input as request(
		"aurora", ["portfolio-write"], "resource://research", ["research:write"], "aurora",
	)
}

test_customer_admin_spans_own_tenant_resources if {
	authz.result.decision == "allow" with input as request(
		"aurora", ["customer-admin"], "resource://compliance", ["compliance:admin"], "aurora",
	)
}

test_customer_admin_is_tenant_scoped if {
	authz.result.decision == "deny" with input as request(
		"aurora", ["customer-admin"], "resource://portfolio", ["portfolio:admin"], "borealis",
	)
}

test_auditor_reads_every_resource if {
	authz.result.decision == "allow" with input as request(
		"aurora", ["auditor"], "resource://research", ["research:read"], "aurora",
	)
}

test_auditor_cannot_write if {
	authz.result.decision == "deny" with input as request(
		"aurora", ["auditor"], "resource://portfolio", ["portfolio:write"], "aurora",
	)
}

# Delegated advisor: allowed only for scopes carried on the delegation edge.
test_delegated_advisor_within_edge if {
	authz.result.decision == "allow" with input as object.union(
		request("aurora", ["delegated-advisor"], "resource://research", ["research:read"], "aurora"),
		{"delegation_edge": {"id": "edge-1", "scopes": ["research:read"]}},
	)
}

test_delegated_advisor_cannot_exceed_edge if {
	authz.result.decision == "deny" with input as object.union(
		request("aurora", ["delegated-advisor"], "resource://portfolio", ["portfolio:read"], "aurora"),
		{"delegation_edge": {"id": "edge-1", "scopes": ["research:read"]}},
	)
}

test_delegated_advisor_requires_an_edge if {
	authz.result.decision == "deny" with input as request(
		"aurora", ["delegated-advisor"], "resource://research", ["research:read"], "aurora",
	)
}

# Emergency access: denied without a step-up, and raises a step-up diagnostic.
test_emergency_without_step_up_is_denied if {
	result := authz.result with input as object.union(
		request("aurora", ["emergency-access"], "resource://portfolio", ["portfolio:admin"], "aurora"),
		{"context": {
			"requested_scopes": ["portfolio:admin"],
			"subject_claims": {"tenant_id": "aurora"},
			"challenge_resolved": false,
		}},
	)
	result.decision == "deny"
	result.diagnostics[_] == {"step_up_required": "mfa"}
}

test_emergency_with_step_up_allows if {
	authz.result.decision == "allow" with input as object.union(
		request("aurora", ["emergency-access"], "resource://portfolio", ["portfolio:admin"], "aurora"),
		{"context": {
			"requested_scopes": ["portfolio:admin"],
			"subject_claims": {"tenant_id": "aurora"},
			"challenge_resolved": true,
		}},
	)
}

# A principal with no Lynx capability is denied by the default-deny base.
test_unlabelled_principal_is_denied if {
	authz.result.decision == "deny" with input as request(
		"aurora", [], "resource://portfolio", ["portfolio:read"], "aurora",
	)
}

# A DCR tenant application acting as itself binds tenancy through its actor claims.
test_dcr_application_binds_via_actor_claims if {
	authz.result.decision == "allow" with input as {
		"action": {"id": "TokenExchange"},
		"principal": {
			"id": "app_dcr_aurora",
			"registration_method": "dcr",
			"labels": ["tenant:aurora", "portfolio-read"],
		},
		"resource": {"identifier": "resource://portfolio"},
		"context": {
			"requested_scopes": ["portfolio:read"],
			"actor_claims": {"tenant_id": "aurora"},
		},
	}
}
