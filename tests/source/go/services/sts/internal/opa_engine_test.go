// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OPA engine path tests: zone load failures, result shape validation, polling, seeding, and simulation guards.

package internal

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func opaTestInput(zoneID string) OPAInput {
	return OPAInput{
		Principal: OPAPrincipal{Type: "Application", ID: "app1", ZoneID: zoneID},
		Resource:  OPAResource{Type: "Resource", ID: "res1", Identifier: "resource://pipernet"},
		Action:    OPAAction{ID: "TokenExchange"},
	}
}

// noBindingDB reports no active policy binding on top of the shared stub.
type noBindingDB struct{ stubDB }

func (noBindingDB) GetActivePolicySetBinding(context.Context, string) (*PolicySetBinding, error) {
	return nil, pgx.ErrNoRows
}

func TestEvaluateLoadErrorAndFallback(t *testing.T) {
	failing := newOPAEngine(&stubDB{})
	if _, err := failing.Evaluate(context.Background(), opaTestInput("zone-err")); err == nil {
		t.Fatal("transient binding failure without a cached bundle must fail evaluation")
	}
	if failing.metrics.EvalErrors.Load() == 0 {
		t.Fatal("evaluation failure must count as an eval error")
	}

	unbound := newOPAEngine(&noBindingDB{})
	result, err := unbound.Evaluate(context.Background(), opaTestInput("zone-unbound"))
	if err != nil {
		t.Fatalf("unbound zone must fall back to deny-all: %v", err)
	}
	if result.Decision != "deny" || result.EvaluationStatus != "complete" {
		t.Fatalf("fallback result = %+v", result)
	}
	if result.Bundle.ManifestSHA != "no_active_policy_set" || result.Bundle.DecisionContractSHA == "" {
		t.Fatalf("evaluation bundle provenance = %+v", result.Bundle)
	}
}

func TestEvaluateRejectsMalformedResultShape(t *testing.T) {
	engine := runCredentialZoneEngine(t, "zone-shape", `
package caracal.authz
result := {"decision": 5, "evaluation_status": "complete"}
`)
	if _, err := engine.Evaluate(context.Background(), opaTestInput("zone-shape")); err == nil {
		t.Fatal("non-string decision must fail result decoding")
	}
	if engine.metrics.EvalErrors.Load() != 1 {
		t.Fatalf("eval errors = %d", engine.metrics.EvalErrors.Load())
	}
}

// pollDB signals every binding lookup on top of the shared stub.
type pollDB struct {
	stubDB
	calls chan struct{}
}

func (d *pollDB) GetActivePolicySetBinding(context.Context, string) (*PolicySetBinding, error) {
	select {
	case d.calls <- struct{}{}:
	default:
	}
	return nil, pgx.ErrNoRows
}

func TestStartPGPollingReloadsKnownZones(t *testing.T) {
	db := &pollDB{calls: make(chan struct{}, 1)}
	engine := newOPAEngine(db)
	engine.SetPollInterval(time.Millisecond)
	engine.storeFallback("zone-poll")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		engine.StartPGPolling(ctx)
		close(done)
	}()
	select {
	case <-db.calls:
	case <-time.After(5 * time.Second):
		t.Fatal("polling never reloaded the known zone")
	}
	cancel()
	<-done
}

// seedDB scripts the bound zone list on top of the shared stub.
type seedDB struct {
	stubDB
	zones   []string
	listErr error
}

func (d *seedDB) ListBoundZoneIDs(context.Context) ([]string, error) {
	return d.zones, d.listErr
}

func TestSeedZonesBranches(t *testing.T) {
	newOPAEngine(nil).SeedZones(context.Background())

	listFail := newOPAEngine(&seedDB{listErr: errors.New("list failed")})
	listFail.SeedZones(context.Background())
	if info := listFail.BundleInfo("zone-a"); info.ManifestSHA != "" {
		t.Fatalf("list failure must seed nothing, got %+v", info)
	}

	engine := newOPAEngine(&seedDB{zones: []string{"zone-a"}})
	engine.SeedZones(context.Background())
	if info := engine.BundleInfo("zone-a"); info.ManifestSHA != "no_active_policy_set" {
		t.Fatalf("failed zone load must install the deny-all fallback, got %+v", info)
	}
}

func TestSimulateGuards(t *testing.T) {
	engine := newOPAEngine(nil)

	if _, err := engine.Simulate(context.Background(), OPAInput{SchemaVersion: "1999-01-01"}, nil); err == nil {
		t.Fatal("unsupported schema version must fail simulation")
	}
	defining := []OPAPolicyModule{{ID: "adopter", Content: `
package caracal.authz
result := {"decision": "allow"}
`}}
	if _, err := engine.Simulate(context.Background(), opaTestInput("zone-sim"), defining); err == nil {
		t.Fatal("adopter module defining result must be rejected")
	}
	malformed := []OPAPolicyModule{{ID: "broken", Content: "package"}}
	if _, err := engine.Simulate(context.Background(), opaTestInput("zone-sim"), malformed); err == nil {
		t.Fatal("unparseable module must be rejected")
	}
}

func TestMetricsSnapshotComputesBundleAge(t *testing.T) {
	engine := newOPAEngine(nil)
	engine.zones["zone-old"] = &opaZoneState{loadedAt: time.Now().Add(-3 * time.Second)}
	engine.zones["zone-unloaded"] = &opaZoneState{}
	snapshot := engine.MetricsSnapshot()
	if snapshot.MaxPolicyAgeSeconds < 2 {
		t.Fatalf("max policy age = %v", snapshot.MaxPolicyAgeSeconds)
	}
}
