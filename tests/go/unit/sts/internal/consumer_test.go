// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis stream consumer handler unit tests: revocation and policy invalidation.

package internal

import (
	"context"
	"testing"

	"github.com/open-policy-agent/opa/rego"
)

func TestHandleRevocationMissingZoneID(t *testing.T) {
	s := &Server{db: &stubDB{}}
	err := s.handleRevocation(context.Background(), streamMessage{
		ID:     "1-0",
		Values: map[string]any{"session_id": "sid"},
	})
	if err == nil {
		t.Error("want error when zone_id is missing")
	}
}

func TestHandleRevocationMissingSessionID(t *testing.T) {
	s := &Server{db: &stubDB{}}
	err := s.handleRevocation(context.Background(), streamMessage{
		ID:     "2-0",
		Values: map[string]any{"zone_id": "z1", "session_id": ""},
	})
	if err == nil {
		t.Error("want error when session_id is empty string")
	}
}

func TestHandleRevocationCallsRevokeSession(t *testing.T) {
	db := &stubDB{}
	s := &Server{db: db}
	err := s.handleRevocation(context.Background(), streamMessage{
		ID:     "3-0",
		Values: map[string]any{"zone_id": "z1", "session_id": "sid-abc"},
	})
	if err != nil {
		t.Errorf("want nil, got %v", err)
	}
}

func TestHandlePolicyInvalidationMissingZoneID(t *testing.T) {
	e := newOPAEngine(nil)
	s := &Server{db: &stubDB{}, opa: e}
	err := s.handlePolicyInvalidation(context.Background(), streamMessage{
		ID:     "4-0",
		Values: map[string]any{},
	})
	if err == nil {
		t.Error("want error when zone_id is missing")
	}
}

func TestHandlePolicyInvalidationEmptyZoneID(t *testing.T) {
	e := newOPAEngine(nil)
	s := &Server{db: &stubDB{}, opa: e}
	err := s.handlePolicyInvalidation(context.Background(), streamMessage{
		ID:     "5-0",
		Values: map[string]any{"zone_id": ""},
	})
	if err == nil {
		t.Error("want error when zone_id is empty string")
	}
}

func TestHandlePolicyInvalidationReloadsZone(t *testing.T) {
	allowRego := `package caracal.authz
result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}`
	db := &stubDB{}
	e := newOPAEngine(db)
	pq, err := rego.New(
		rego.Module("allow.rego", allowRego),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.zones["z-reload"] = &opaZoneState{query: &pq}
	e.mu.Unlock()

	s := &Server{db: db, opa: e}

	// handlePolicyInvalidation calls Reload which calls loadZone.
	// stubDB.GetActivePolicySetBinding returns error → storeFallback is called.
	// The zone entry is replaced with a fallback (not removed), so it still exists.
	err = s.handlePolicyInvalidation(context.Background(), streamMessage{
		ID:     "6-0",
		Values: map[string]any{"zone_id": "z-reload"},
	})
	if err != nil {
		t.Errorf("handlePolicyInvalidation must not return error when reload falls back: %v", err)
	}

	e.mu.RLock()
	_, stillPresent := e.zones["z-reload"]
	e.mu.RUnlock()
	if !stillPresent {
		t.Error("zone must remain in OPA cache after reload (fallback installed)")
	}
}

func TestOPAEngineReloadInstallesFallbackWhenNoDB(t *testing.T) {
	e := newOPAEngine(&stubDB{})

	// stubDB returns a transient (non-ErrNoRows) error. With no cached bundle,
	// loadZone installs deny-all fallback and surfaces the underlying error so
	// the operator can see the transient failure.
	err := e.Reload(context.Background(), "zone-no-policy")
	if err == nil {
		t.Error("Reload must surface transient DB error so it is logged")
	}

	e.mu.RLock()
	_, found := e.zones["zone-no-policy"]
	e.mu.RUnlock()
	if !found {
		t.Error("zone must exist after reload installs fallback")
	}
}
func TestStoreFallbackSetsPolicy(t *testing.T) {
	e := newOPAEngine(nil)
	e.storeFallback("zone-fb")

	e.mu.RLock()
	_, found := e.zones["zone-fb"]
	e.mu.RUnlock()
	if !found {
		t.Error("storeFallback must register a zone policy entry")
	}
}
