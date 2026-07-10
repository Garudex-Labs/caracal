// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the run credential endpoint: binding resolution, provider eligibility, policy, step-up holds, and minting.

package internal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
	"github.com/open-policy-agent/opa/rego"
	"github.com/rs/zerolog"
)

func runCredentialRequest(t *testing.T, srv *Server, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/run/credential", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	srv.handleRunCredential(w, req)
	return w
}

func runCredentialZoneEngine(t *testing.T, zoneID, policy string) *OPAEngine {
	t.Helper()
	engine := newOPAEngine(nil)
	pq, err := rego.New(
		rego.Module("zone.rego", policy),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatalf("compile zone rego: %v", err)
	}
	engine.mu.Lock()
	engine.zones[zoneID] = &opaZoneState{query: &pq}
	engine.mu.Unlock()
	return engine
}

const runCredentialAllowPolicy = `
package caracal.authz
result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "caracal-workload-mint"}], "diagnostics": []}
`

const runCredentialDenyPolicy = `
package caracal.authz
result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": [{"reason": "no_rule_matched"}]}
`

const runCredentialGatedPolicy = `
package caracal.authz
result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "caracal-workload-mint"}], "diagnostics": [{"step_up_required": {"type": "human_approval", "tiers": [{"tier": "money", "approver": "operator", "ttl_seconds": 600, "privacy": "identified"}]}}]}
`

func runCredentialServer(t *testing.T, db *stubDB, policy string) (*Server, string) {
	t.Helper()
	hash, err := hashClientSecret("ws_good")
	if err != nil {
		t.Fatalf("hash secret: %v", err)
	}
	if db.workload != nil && db.workload.SecretHash == "" {
		db.workload.SecretHash = hash
	}
	zek := []byte("12345678901234567890123456789012")
	srv := &Server{
		db:          db,
		redis:       newMemSTSRedis(),
		opa:         runCredentialZoneEngine(t, "z1", policy),
		auditBuffer: &AuditBuffer{ch: make(chan AuditEvent, 100)},
		keys:        &KeyCache{keyring: testKeyring(zek)},
		secrets:     secretstore.Opened(&builtinSecretBackend{db: db}, testKeyring(zek)),
		log:         zerolog.Nop(),
	}
	return srv, "ws_good"
}

func runCredentialWorkload() *Workload {
	return &Workload{
		ID:       "wl-1",
		ZoneID:   "z1",
		Name:     "Son of Anton",
		Bindings: []byte(`[{"env": "PIPERNET_TOKEN", "resource": "resource://pipernet", "scopes": ["pipernet:read"]}]`),
	}
}

func runCredentialResource(providerID string) *Resource {
	return &Resource{
		ID:                   "res1",
		ZoneID:               "z1",
		Identifier:           "resource://pipernet",
		Scopes:               []string{"pipernet:read"},
		CredentialProviderID: &providerID,
	}
}

func runCredentialProvider(allowInjection bool) *ProviderConfig {
	config := `{"header_name":"X-Api-Key","allow_runtime_injection":true}`
	if !allowInjection {
		config = `{"header_name":"X-Api-Key"}`
	}
	return &ProviderConfig{
		ID:           "provider1",
		ProviderKind: strPtr("api_key"),
		ConfigJSON:   []byte(config),
	}
}

func runCredentialProviderSecret(t *testing.T, zek []byte) map[string][]byte {
	t.Helper()
	return testProviderSecret(t, zek, "provider1", `{"api_key":"pipernet-api-key"}`)
}

func TestRunCredentialRequiresParams(t *testing.T) {
	srv, _ := runCredentialServer(t, &stubDB{}, runCredentialAllowPolicy)
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {"ws_good"}})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRunCredentialOpaqueAuthFailure(t *testing.T) {
	srv, _ := runCredentialServer(t, &stubDB{}, runCredentialAllowPolicy)
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {"ws_wrong"}, "env": {"PIPERNET_TOKEN"}})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if !strings.Contains(w.Body.String(), "invalid workload credentials") {
		t.Fatalf("want opaque credential error, got %s", w.Body.String())
	}
}

func TestRunCredentialUnknownEnv(t *testing.T) {
	db := &stubDB{workload: runCredentialWorkload()}
	srv, secret := runCredentialServer(t, db, runCredentialAllowPolicy)
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {secret}, "env": {"OTHER_TOKEN"}})
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "no credential binding for env OTHER_TOKEN") {
		t.Fatalf("want unknown-env error, got %s", w.Body.String())
	}
}

func TestRunCredentialProviderMustAllowInjection(t *testing.T) {
	zek := []byte("12345678901234567890123456789012")
	db := &stubDB{
		workload:       runCredentialWorkload(),
		resource:       runCredentialResource("provider1"),
		provider:       runCredentialProvider(false),
		storeEnvelopes: runCredentialProviderSecret(t, zek),
	}
	srv, secret := runCredentialServer(t, db, runCredentialAllowPolicy)
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {secret}, "env": {"PIPERNET_TOKEN"}})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "does not allow runtime credential injection") {
		t.Fatalf("want injection-denied error, got %s", w.Body.String())
	}
}

func TestRunCredentialUserGrantProviderDenied(t *testing.T) {
	db := &stubDB{
		workload: runCredentialWorkload(),
		resource: runCredentialResource("provider1"),
		provider: &ProviderConfig{
			ID:           "provider1",
			ProviderKind: strPtr("oauth2_authorization_code"),
			ConfigJSON:   []byte(`{"allow_runtime_injection":true}`),
		},
	}
	srv, secret := runCredentialServer(t, db, runCredentialAllowPolicy)
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {secret}, "env": {"PIPERNET_TOKEN"}})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "no user principal") {
		t.Fatalf("want user-consent error, got %s", w.Body.String())
	}
}

func TestRunCredentialPolicyDeny(t *testing.T) {
	zek := []byte("12345678901234567890123456789012")
	db := &stubDB{
		workload:       runCredentialWorkload(),
		resource:       runCredentialResource("provider1"),
		provider:       runCredentialProvider(true),
		storeEnvelopes: runCredentialProviderSecret(t, zek),
	}
	srv, secret := runCredentialServer(t, db, runCredentialDenyPolicy)
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {secret}, "env": {"PIPERNET_TOKEN"}})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "policy denied") {
		t.Fatalf("want policy denial, got %s", w.Body.String())
	}
}

func TestRunCredentialStepUpHold(t *testing.T) {
	zek := []byte("12345678901234567890123456789012")
	db := &stubDB{
		workload:       runCredentialWorkload(),
		resource:       runCredentialResource("provider1"),
		provider:       runCredentialProvider(true),
		storeEnvelopes: runCredentialProviderSecret(t, zek),
	}
	srv, secret := runCredentialServer(t, db, runCredentialGatedPolicy)
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {secret}, "env": {"PIPERNET_TOKEN"}})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 hold: %s", w.Code, w.Body.String())
	}
	var challenge StepUpChallenge
	if err := json.Unmarshal(w.Body.Bytes(), &challenge); err != nil {
		t.Fatalf("decode challenge: %v", err)
	}
	if challenge.Error != "interaction_required" || challenge.ChallengeID == "" {
		t.Fatalf("want interaction_required challenge, got %+v", challenge)
	}
}

func TestRunCredentialSuccess(t *testing.T) {
	zek := []byte("12345678901234567890123456789012")
	db := &stubDB{
		workload:       runCredentialWorkload(),
		resource:       runCredentialResource("provider1"),
		provider:       runCredentialProvider(true),
		storeEnvelopes: runCredentialProviderSecret(t, zek),
	}
	srv, secret := runCredentialServer(t, db, runCredentialAllowPolicy)
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {secret}, "env": {"PIPERNET_TOKEN"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp RunCredentialResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Env != "PIPERNET_TOKEN" || resp.Credential != "pipernet-api-key" {
		t.Fatalf("credential mismatch: %+v", resp)
	}
}

func TestRunCredentialFailsClosedWithoutRedis(t *testing.T) {
	srv := &Server{db: &stubDB{}, redis: nil}
	w := runCredentialRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {"ws_good"}, "env": {"PIPERNET_TOKEN"}})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
}
