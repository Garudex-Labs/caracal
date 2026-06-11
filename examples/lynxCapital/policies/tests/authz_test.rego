# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Decision tests for the Lynx Capital policy library across bootstrap, mint, and use.
package caracal.authz_test

import rego.v1

import data.caracal.authz

bootstrap_input(app_id, resource) := {
	"principal": {"type": "Application", "id": app_id, "zone_id": "zone-1", "registration_method": "managed"},
	"resource": {"type": "Resource", "id": "res-1", "identifier": resource, "scopes": ["agent:lifecycle"]},
	"action": {"id": "TokenExchange"},
	"context": {
		"actor_claims": {"caracal_client_id": app_id},
		"trace_id": "t-1",
		"challenge_resolved": false,
		"requested_scopes": ["agent:lifecycle"],
	},
}

mint_input(app_id, labels, resource, edge_scopes, requested) := {
	"principal": {
		"type": "Application", "id": app_id, "zone_id": "zone-1",
		"registration_method": "managed", "agent_session_id": "agent-1",
		"lifecycle": "task", "labels": labels,
	},
	"resource": {"type": "Resource", "id": "res-1", "identifier": resource, "scopes": requested},
	"action": {"id": "TokenExchange"},
	"delegation_edge": {
		"id": "edge-1", "source_session_id": "root-1", "target_session_id": "agent-1",
		"issuer_application_id": app_id, "receiver_application_id": app_id,
		"scopes": edge_scopes, "edge_version": 1, "path": ["root-1", "agent-1"], "graph_epoch": 1,
	},
	"context": {
		"actor_claims": {"caracal_client_id": app_id},
		"trace_id": "t-1",
		"agent_session_id": "agent-1",
		"delegation_edge_id": "edge-1",
		"challenge_resolved": false,
		"requested_scopes": requested,
	},
}

use_input(app_id, labels, resource, target) := {
	"principal": {
		"type": "Application", "id": app_id, "zone_id": "zone-1",
		"registration_method": "managed", "agent_session_id": "agent-1",
		"lifecycle": "task", "labels": labels,
	},
	"resource": {"type": "Resource", "id": "res-1", "identifier": resource, "scopes": ["agent:lifecycle"]},
	"action": {"id": "TokenExchange"},
	"context": {
		"actor_claims": {"caracal_client_id": "gateway"},
		"subject_claims": {
			"sub": app_id, "agent_session_id": "agent-1",
			"delegation_edge_id": "edge-1", "target": target,
		},
		"trace_id": "t-1",
		"agent_session_id": "agent-1",
		"challenge_resolved": false,
		"requested_scopes": [],
	},
}

test_default_deny if {
	authz.result.decision == "deny" with input as {"principal": {}, "resource": {}, "context": {}}
}

test_bootstrap_allows_owned_view if {
	authz.result.decision == "allow" with input as bootstrap_input("app-intake", "resource://intake-inkwell")
}

test_bootstrap_denies_foreign_view if {
	authz.result.decision == "deny" with input as bootstrap_input("app-intake", "resource://ledger-ironbark")
}

test_bootstrap_denies_unknown_application if {
	authz.result.decision == "deny" with input as bootstrap_input("app-unknown", "resource://intake-inkwell")
}

test_bootstrap_denies_extra_scopes if {
	base := bootstrap_input("app-payments", "resource://payments-meridian")
	denied := json.patch(base, [{"op": "replace", "path": "/context/requested_scopes", "value": ["agent:lifecycle", "meridian:payout"]}])
	authz.result.decision == "deny" with input as denied
}

test_mint_allows_role_scope_inside_edge if {
	authz.result.decision == "allow" with input as mint_input(
		"app-payments", ["payment-execution", "lynx-swarm"],
		"resource://payments-meridian", ["meridian:payout"], ["meridian:payout"],
	)
}

test_mint_determining_policy_names_application if {
	decided := authz.result with input as mint_input(
		"app-payments", ["payment-execution", "lynx-swarm"],
		"resource://payments-meridian", ["meridian:payout"], ["meridian:payout"],
	)
	decided.determining_policies == [{"policy": "lynx-payments-mint"}]
}

test_mint_denies_scope_beyond_role if {
	authz.result.decision == "deny" with input as mint_input(
		"app-payments", ["payments", "lynx-swarm"],
		"resource://payments-meridian", ["meridian:payout"], ["meridian:payout"],
	)
}

test_mint_denies_scope_outside_edge if {
	authz.result.decision == "deny" with input as mint_input(
		"app-payments", ["payment-execution", "lynx-swarm"],
		"resource://payments-meridian", ["halcyon:read"], ["meridian:payout"],
	)
}

test_mint_denies_without_delegation_edge if {
	base := mint_input(
		"app-payments", ["payment-execution", "lynx-swarm"],
		"resource://payments-meridian", ["meridian:payout"], ["meridian:payout"],
	)
	denied := json.remove(base, ["/delegation_edge"])
	authz.result.decision == "deny" with input as denied
}

test_mint_denies_cross_application_view if {
	authz.result.decision == "deny" with input as mint_input(
		"app-intake", ["payment-execution", "lynx-swarm"],
		"resource://payments-meridian", ["meridian:payout"], ["meridian:payout"],
	)
}

test_mint_denies_lifecycle_scope if {
	authz.result.decision == "deny" with input as mint_input(
		"app-payments", ["payment-execution", "lynx-swarm"],
		"resource://payments-meridian", ["agent:lifecycle"], ["agent:lifecycle"],
	)
}

test_mint_allows_partner_integration_on_integration_view if {
	authz.result.decision == "allow" with input as mint_input(
		"app-audit", ["partner-integration", "lynx-swarm"],
		"resource://audit-meridian", ["meridian:read"], ["meridian:read"],
	)
}

test_mint_denies_partner_integration_on_non_integration_view if {
	authz.result.decision == "deny" with input as mint_input(
		"app-payments", ["partner-integration", "lynx-swarm"],
		"resource://payments-meridian", ["meridian:payout"], ["meridian:payout"],
	)
}

test_mint_allows_customer_labeled_receivables_scope if {
	authz.result.decision == "allow" with input as mint_input(
		"app-ledger", ["receivables", "lynx-swarm", "customer:cust-204"],
		"resource://ledger-corebilling", ["corebilling:collect"], ["corebilling:collect"],
	)
}

test_mint_denies_customer_labeled_agent_outside_customer_scopes if {
	authz.result.decision == "deny" with input as mint_input(
		"app-ledger", ["ledger-match", "lynx-swarm", "customer:cust-204"],
		"resource://ledger-ironbark", ["ironbark:read"], ["ironbark:read"],
	)
}

test_use_allows_targeted_mandate if {
	authz.result.decision == "allow" with input as use_input(
		"app-payments", ["payment-execution", "lynx-swarm"],
		"resource://payments-meridian", ["resource://payments-meridian"],
	)
}

test_use_determining_policy_names_application if {
	decided := authz.result with input as use_input(
		"app-ledger", ["ledger-match", "lynx-swarm"],
		"resource://ledger-ironbark", ["resource://ledger-ironbark"],
	)
	decided.determining_policies == [{"policy": "lynx-ledger-use"}]
}

test_use_denies_resource_outside_target if {
	authz.result.decision == "deny" with input as use_input(
		"app-payments", ["payment-execution", "lynx-swarm"],
		"resource://payments-quetzal", ["resource://payments-meridian"],
	)
}

test_use_denies_role_without_grant if {
	authz.result.decision == "deny" with input as use_input(
		"app-payments", ["payments", "lynx-swarm"],
		"resource://payments-meridian", ["resource://payments-meridian"],
	)
}

test_use_denies_without_delegation_claim if {
	base := use_input(
		"app-payments", ["payment-execution", "lynx-swarm"],
		"resource://payments-meridian", ["resource://payments-meridian"],
	)
	denied := json.remove(base, ["/context/subject_claims/delegation_edge_id"])
	authz.result.decision == "deny" with input as denied
}
