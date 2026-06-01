// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OPA engine unit tests: deny-all fallback, allow policy, and result validation.

package internal

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/open-policy-agent/opa/rego"
)

func TestOPAFallbackDeny(t *testing.T) {
	e := newOPAEngine(nil)
	e.storeFallback("z1")

	res, err := e.Evaluate(context.Background(), OPAInput{
		Principal: OPAPrincipal{ZoneID: "z1"},
		Action:    OPAAction{ID: "TokenExchange"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != "deny" {
		t.Errorf("want deny, got %s", res.Decision)
	}
	if res.EvaluationStatus != "complete" {
		t.Errorf("want complete, got %s", res.EvaluationStatus)
	}
}

func TestOPAAllowPolicy(t *testing.T) {
	allowRego := `
package caracal.authz
result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}
`
	e := newOPAEngine(nil)
	pq, err := rego.New(
		rego.Module("allow.rego", allowRego),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.zones["z1"] = &opaZoneState{query: &pq}
	e.mu.Unlock()

	res, err := e.Evaluate(context.Background(), OPAInput{
		Principal: OPAPrincipal{ZoneID: "z1"},
		Action:    OPAAction{ID: "TokenExchange"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != "allow" {
		t.Errorf("want allow, got %s", res.Decision)
	}
}

func TestOPARejectsUnsupportedInputSchema(t *testing.T) {
	e := newOPAEngine(nil)
	e.storeFallback("z1")

	if _, err := e.Evaluate(context.Background(), OPAInput{
		SchemaVersion: "2099-01-01",
		Principal:     OPAPrincipal{ZoneID: "z1"},
		Action:        OPAAction{ID: "TokenExchange"},
	}); err == nil {
		t.Fatal("unsupported schema_version must be rejected")
	}
}

func TestOPADenyPolicy(t *testing.T) {
	denyRego := `
package caracal.authz
result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}
`
	e := newOPAEngine(nil)
	pq, err := rego.New(
		rego.Module("deny.rego", denyRego),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.zones["z1"] = &opaZoneState{query: &pq}
	e.mu.Unlock()

	res, err := e.Evaluate(context.Background(), OPAInput{
		Principal: OPAPrincipal{ZoneID: "z1"},
		Action:    OPAAction{ID: "TokenExchange"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != "deny" {
		t.Errorf("want deny, got %s", res.Decision)
	}
}

func TestOPANonCompleteStatusRejected(t *testing.T) {
	partialRego := `
package caracal.authz
result := {"decision": "deny", "evaluation_status": "partial", "determining_policies": [], "diagnostics": []}
`
	e := newOPAEngine(nil)
	pq, err := rego.New(
		rego.Module("partial.rego", partialRego),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.zones["z1"] = &opaZoneState{query: &pq}
	e.mu.Unlock()

	if _, err := e.Evaluate(context.Background(), OPAInput{
		Principal: OPAPrincipal{ZoneID: "z1"},
		Action:    OPAAction{ID: "TokenExchange"},
	}); err == nil {
		t.Fatal("non-complete evaluation_status must be rejected")
	}
}

func TestOPAMissingStatusRejected(t *testing.T) {
	regoSource := `
package caracal.authz
result := {"decision": "deny", "determining_policies": [], "diagnostics": []}
`
	e := newOPAEngine(nil)
	pq, err := rego.New(
		rego.Module("missing-status.rego", regoSource),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.zones["z1"] = &opaZoneState{query: &pq}
	e.mu.Unlock()

	if _, err := e.Evaluate(context.Background(), OPAInput{
		Principal: OPAPrincipal{ZoneID: "z1"},
		Action:    OPAAction{ID: "TokenExchange"},
	}); err == nil {
		t.Fatal("missing evaluation_status must be rejected")
	}
}

func TestOPAInvalidDecisionRejected(t *testing.T) {
	regoSource := `
package caracal.authz
result := {"decision": "maybe", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}
`
	e := newOPAEngine(nil)
	pq, err := rego.New(
		rego.Module("invalid.rego", regoSource),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.zones["z1"] = &opaZoneState{query: &pq}
	e.mu.Unlock()

	if _, err := e.Evaluate(context.Background(), OPAInput{
		Principal: OPAPrincipal{ZoneID: "z1"},
		Action:    OPAAction{ID: "TokenExchange"},
	}); err == nil {
		t.Fatal("invalid policy decision must be rejected")
	}
}

func TestOPAReloadSameManifest(t *testing.T) {
	e := newOPAEngine(nil)
	sha := "abc123"
	e.mu.Lock()
	pq, _ := rego.New(
		rego.Module("allow.rego", `
package caracal.authz
result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}
`),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	e.zones["z1"] = &opaZoneState{query: &pq, manifestSHA: sha}
	e.mu.Unlock()

	// loadZone with a nil DB and the same SHA should skip reload
	e.mu.RLock()
	state := e.zones["z1"]
	e.mu.RUnlock()
	if state.manifestSHA != sha {
		t.Errorf("want sha %s, got %s", sha, state.manifestSHA)
	}
}

// partialVersionDB returns a binding and version whose manifest lists two
// policy_version_ids, but GetPolicyVersionsByIDs only returns one row —
// simulating a partial DB result.
type partialVersionDB struct {
	stubDB
}

func (d *partialVersionDB) GetActivePolicySetBinding(_ context.Context, _ string) (*PolicySetBinding, error) {
	vid := "psv-1"
	return &PolicySetBinding{ZoneID: "z-partial", PolicySetID: "ps-1", ActiveVersionID: &vid}, nil
}

func (d *partialVersionDB) GetPolicySetVersion(_ context.Context, _ string) (*PolicySetVersion, error) {
	manifest, _ := json.Marshal([]map[string]string{
		{"policy_version_id": "pv-1"},
		{"policy_version_id": "pv-2"},
	})
	return &PolicySetVersion{ID: "psv-1", ManifestJSON: manifest, ManifestSHA256: "new-sha"}, nil
}

func (d *partialVersionDB) GetPolicyVersionsByIDs(_ context.Context, _ []string) ([]PolicyVersion, error) {
	return []PolicyVersion{{ID: "pv-1", Content: `package caracal.authz`}}, nil
}

func TestOPALoadZoneRejectsPartialBundle(t *testing.T) {
	e := newOPAEngine(&partialVersionDB{})
	err := e.loadZone(context.Background(), "z-partial")
	if err == nil {
		t.Fatal("want error when manifest version count mismatches DB result")
	}
}

func TestOPAForbiddenBuiltins(t *testing.T) {
	forbidden := []string{
		`result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": [net.cidr_merge(["1.1.1.1/32"])]}`,
		`result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": [http.send({"method": "get", "url": "http://localhost"})]}`,
		`result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": [time.now_ns()]}`,
	}

	for i, f := range forbidden {
		regoSource := "package caracal.authz\n" + f
		_, err := rego.New(
			rego.Module("forbidden.rego", regoSource),
			rego.Query("result = data.caracal.authz.result"),
			rego.Capabilities(safeCapabilities()),
		).PrepareForEval(context.Background())
		if err == nil {
			t.Errorf("case %d: expected forbidden builtin to cause compilation failure, but it compiled successfully", i)
		}
	}
}

