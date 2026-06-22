// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the embedded platform decision contract: the authorization brain and its data-only guard.

package internal

import (
	"context"
	"testing"
)

// grantsData and bindingData are the adopter data documents the contract reads. They
// stand in for the grants and bindings a zone supplies; the contract owns every rule.
const grantsData = `package caracal.authz

import rego.v1

grants := {"resource://nucleus": {"application": "payments", "roles": {"payment-execution": ["nucleus:pay"]}}}
app_ids := {"payments": "app-payments"}
`

const confinementData = `package caracal.authz

import rego.v1

confinement := [{"label_prefix": "customer:", "scopes": ["nucleus:read"]}]
`

func dataModules(extra ...OPAPolicyModule) []OPAPolicyModule {
	mods := []OPAPolicyModule{{ID: "grants", Content: grantsData}}
	return append(mods, extra...)
}

func simulateContract(t *testing.T, input OPAInput, policies []OPAPolicyModule) *OPAResult {
	t.Helper()
	input.SchemaVersion = "2026-05-20"
	res, err := newOPAEngine(nil).Simulate(context.Background(), input, policies)
	if err != nil {
		t.Fatalf("simulate: %v", err)
	}
	return res
}

func TestDecisionContractVerifies(t *testing.T) {
	if err := verifyDecisionContract(); err != nil {
		t.Fatalf("embedded decision contract must verify: %v", err)
	}
	if DecisionContractVersion == "" {
		t.Fatal("decision contract version must be set")
	}
	if len(decisionContractSHA256) != 64 {
		t.Fatalf("decision contract sha256 must be 64 hex chars, got %d", len(decisionContractSHA256))
	}
}

func TestDecisionContractBootstrapAllow(t *testing.T) {
	res := simulateContract(t, OPAInput{
		Principal: OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application"},
		Resource:  OPAResource{Identifier: "resource://nucleus"},
		Action:    OPAAction{ID: "token_exchange"},
		Context:   OPAContext{RequestedScopes: []string{"agent:lifecycle"}, ActorClaims: map[string]any{}},
	}, dataModules())
	if res.Decision != "allow" {
		t.Fatalf("bootstrap exchange must allow, got %q", res.Decision)
	}
}

func TestDecisionContractDelegatedMintAllow(t *testing.T) {
	res := simulateContract(t, OPAInput{
		Principal:      OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application", Labels: []string{"payment-execution"}},
		Resource:       OPAResource{Identifier: "resource://nucleus"},
		Action:         OPAAction{ID: "token_exchange"},
		DelegationEdge: &OPADelegationEdge{ID: "edge1", Scopes: []string{"nucleus:pay"}},
		Context: OPAContext{
			AgentSessionID:  "agent-1",
			RequestedScopes: []string{"nucleus:pay"},
			ActorClaims:     map[string]any{},
		},
	}, dataModules())
	if res.Decision != "allow" {
		t.Fatalf("delegated mint within edge must allow, got %q", res.Decision)
	}
}

// TestDecisionContractDelegatedMintNarrowing is the floor that the hand-authored Rego
// silently lost across adopters: a scope the delegation edge never granted must never
// be mintable, even when the role grant and resource would otherwise allow it.
func TestDecisionContractDelegatedMintNarrowing(t *testing.T) {
	res := simulateContract(t, OPAInput{
		Principal:      OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application", Labels: []string{"payment-execution"}},
		Resource:       OPAResource{Identifier: "resource://nucleus"},
		Action:         OPAAction{ID: "token_exchange"},
		DelegationEdge: &OPADelegationEdge{ID: "edge1", Scopes: []string{"nucleus:read"}},
		Context: OPAContext{
			AgentSessionID:  "agent-1",
			RequestedScopes: []string{"nucleus:pay"},
			ActorClaims:     map[string]any{},
		},
	}, dataModules())
	if res.Decision != "deny" {
		t.Fatalf("scope outside delegation edge must deny, got %q", res.Decision)
	}
}

func TestDecisionContractApprovalGate(t *testing.T) {
	approval := `package caracal.authz

import rego.v1

approval := [{"scope": "nucleus:pay"}]
`
	input := OPAInput{
		Principal:      OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application", Labels: []string{"payment-execution"}},
		Resource:       OPAResource{Identifier: "resource://nucleus"},
		Action:         OPAAction{ID: "token_exchange"},
		DelegationEdge: &OPADelegationEdge{ID: "edge1", Scopes: []string{"nucleus:pay"}},
		Context: OPAContext{
			AgentSessionID:  "agent-1",
			RequestedScopes: []string{"nucleus:pay"},
			ActorClaims:     map[string]any{},
		},
	}
	gated := simulateContract(t, input, dataModules(OPAPolicyModule{ID: "approval", Content: approval}))
	if gated.Decision != "allow" {
		t.Fatalf("an approval-gated mint stays allow pending approval, got %q", gated.Decision)
	}
	if stepUpRequired(gated) != "human_approval" {
		t.Fatalf("an approval-gated mint must mark human_approval step-up, diagnostics %+v", gated.Diagnostics)
	}
	ungated := simulateContract(t, input, dataModules())
	if ungated.Decision != "allow" || stepUpRequired(ungated) != "" {
		t.Fatalf("a mint with no approval data must allow without a step-up gate, got %q diagnostics %+v", ungated.Decision, ungated.Diagnostics)
	}
}

func TestDecisionContractConfinementDeny(t *testing.T) {
	res := simulateContract(t, OPAInput{
		Principal:      OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application", Labels: []string{"payment-execution", "customer:acme"}},
		Resource:       OPAResource{Identifier: "resource://nucleus"},
		Action:         OPAAction{ID: "token_exchange"},
		DelegationEdge: &OPADelegationEdge{ID: "edge1", Scopes: []string{"nucleus:pay"}},
		Context: OPAContext{
			AgentSessionID:  "agent-1",
			RequestedScopes: []string{"nucleus:pay"},
			ActorClaims:     map[string]any{},
		},
	}, dataModules(OPAPolicyModule{ID: "confinement", Content: confinementData}))
	if res.Decision != "deny" {
		t.Fatalf("confined label minting outside its scope set must deny, got %q", res.Decision)
	}
}

func TestDecisionContractMandateUseAllow(t *testing.T) {
	res := simulateContract(t, OPAInput{
		Principal: OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application", Labels: []string{"payment-execution"}},
		Resource:  OPAResource{Identifier: "resource://nucleus"},
		Action:    OPAAction{ID: "token_exchange"},
		Context: OPAContext{
			RequestedScopes: []string{},
			SubjectClaims:   map[string]any{"delegation_edge_id": "edge1", "target": []string{"resource://nucleus"}},
			ActorClaims:     map[string]any{},
		},
	}, dataModules())
	if res.Decision != "allow" {
		t.Fatalf("mandate use bound to the resource must allow, got %q", res.Decision)
	}
}

func TestDecisionContractDeniesWithoutData(t *testing.T) {
	res := simulateContract(t, OPAInput{
		Principal: OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application"},
		Resource:  OPAResource{Identifier: "resource://nucleus"},
		Action:    OPAAction{ID: "token_exchange"},
		Context:   OPAContext{RequestedScopes: []string{"agent:lifecycle"}, ActorClaims: map[string]any{}},
	}, nil)
	if res.Decision != "deny" {
		t.Fatalf("a zone with no data must deny, got %q", res.Decision)
	}
}

func TestDecisionContractRestrictionDeny(t *testing.T) {
	restriction := `package caracal.authz

import rego.v1

restrict := {"maintenance_freeze"}
`
	res := simulateContract(t, OPAInput{
		Principal: OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application"},
		Resource:  OPAResource{Identifier: "resource://nucleus"},
		Action:    OPAAction{ID: "token_exchange"},
		Context:   OPAContext{RequestedScopes: []string{"agent:lifecycle"}, ActorClaims: map[string]any{}},
	}, dataModules(OPAPolicyModule{ID: "restriction", Content: restriction}))
	if res.Decision != "deny" {
		t.Fatalf("a non-empty restriction set must deny an otherwise allowed exchange, got %q", res.Decision)
	}
}

func TestDecisionContractRejectsAdopterResult(t *testing.T) {
	adopterDecision := `package caracal.authz

import rego.v1

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}
`
	_, err := newOPAEngine(nil).Simulate(context.Background(), OPAInput{
		SchemaVersion: "2026-05-20",
		Principal:     OPAPrincipal{ID: "app-payments", ZoneID: "z1", Type: "application"},
		Resource:      OPAResource{Identifier: "resource://nucleus"},
		Action:        OPAAction{ID: "token_exchange"},
		Context:       OPAContext{RequestedScopes: []string{"agent:lifecycle"}, ActorClaims: map[string]any{}},
	}, []OPAPolicyModule{{ID: "adopter", Content: adopterDecision}})
	if err == nil {
		t.Fatal("an adopter module that defines result must be rejected")
	}
}

func TestModuleDefinesResultDetection(t *testing.T) {
	defines, err := moduleDefinesResult("d", grantsData)
	if err != nil {
		t.Fatalf("parse data module: %v", err)
	}
	if defines {
		t.Fatal("a data document must not be reported as defining result")
	}
	decision := `package caracal.authz
result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}`
	defines, err = moduleDefinesResult("d", decision)
	if err != nil {
		t.Fatalf("parse decision module: %v", err)
	}
	if !defines {
		t.Fatal("a module defining result must be detected")
	}
}
