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
	risk := `package caracal.authz

import rego.v1

risk := [{"scope": "nucleus:pay", "tier": "money"}]

approval_declarations := [{"tier": "money", "approver": "subject", "ttl_seconds": 900, "privacy": "pseudonymous"}]
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
	gated := simulateContract(t, input, dataModules(OPAPolicyModule{ID: "risk", Content: risk}))
	if gated.Decision != "allow" {
		t.Fatalf("an approval-gated mint stays allow pending approval, got %q", gated.Decision)
	}
	decls := parseTierDeclarations(gated)
	if len(decls) != 1 || decls[0].Tier != "money" || decls[0].Approver != "subject" || decls[0].TTLSeconds != 900 || decls[0].Privacy != "pseudonymous" {
		t.Fatalf("an approval-gated mint must surface the matched declaration, got %+v diagnostics %+v", decls, gated.Diagnostics)
	}
	if riskTier(gated, "nucleus:pay") != "money" {
		t.Fatalf("a gated mint must carry the classified risk tier in diagnostics, got %+v", gated.Diagnostics)
	}
	ungated := simulateContract(t, input, dataModules())
	if ungated.Decision != "allow" || parseTierDeclarations(ungated) != nil {
		t.Fatalf("a mint with no risk data must allow without a step-up gate, got %q diagnostics %+v", ungated.Decision, ungated.Diagnostics)
	}
	if riskTier(ungated, "nucleus:pay") != "" {
		t.Fatalf("an unclassified scope must carry no risk diagnostic, got %+v", ungated.Diagnostics)
	}
}

func TestDecisionContractMalformedDeclarationDenies(t *testing.T) {
	risk := `package caracal.authz

import rego.v1

risk := [{"scope": "nucleus:pay", "tier": "money"}]

approval_declarations := [{"approver": "operator"}]
`
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
	}, dataModules(OPAPolicyModule{ID: "risk", Content: risk}))
	if res.Decision != "deny" {
		t.Fatalf("a tierless approval declaration must fail the mint closed, got %q diagnostics %+v", res.Decision, res.Diagnostics)
	}
}

func TestDecisionContractRiskClassifiedWithoutGate(t *testing.T) {
	risk := `package caracal.authz

import rego.v1

risk := [{"scope": "nucleus:pay", "tier": "sensitive"}]
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
	res := simulateContract(t, input, dataModules(OPAPolicyModule{ID: "risk", Content: risk}))
	if res.Decision != "allow" || parseTierDeclarations(res) != nil {
		t.Fatalf("a classified tier the zone does not gate must allow without step-up, got %q diagnostics %+v", res.Decision, res.Diagnostics)
	}
	if riskTier(res, "nucleus:pay") != "sensitive" {
		t.Fatalf("a classified scope must ride in diagnostics for audit even when ungated, got %+v", res.Diagnostics)
	}
}

func riskTier(result *OPAResult, scope string) string {
	for _, d := range result.Diagnostics {
		entries, ok := d["risk"].([]any)
		if !ok {
			continue
		}
		for _, raw := range entries {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if entry["scope"] == scope {
				tier, _ := entry["tier"].(string)
				return tier
			}
		}
	}
	return ""
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
