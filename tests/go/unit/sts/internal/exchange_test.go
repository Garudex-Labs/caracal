// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Token exchange unit tests: helper functions and handler partial-deny invariant.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/open-policy-agent/opa/rego"
)

func TestDerefStr(t *testing.T) {
	s := "hello"
	if got := derefStr(&s); got != "hello" {
		t.Errorf("want hello, got %s", got)
	}
	if got := derefStr(nil); got != "" {
		t.Errorf("want empty string, got %s", got)
	}
}

func TestStepUpRequired(t *testing.T) {
	res := &OPAResult{
		Diagnostics: []map[string]interface{}{
			{"step_up_required": "mfa"},
		},
	}
	if got := stepUpRequired(res); got != "mfa" {
		t.Errorf("want mfa, got %s", got)
	}
}

func TestStepUpRequiredNone(t *testing.T) {
	res := &OPAResult{Diagnostics: nil}
	if got := stepUpRequired(res); got != "" {
		t.Errorf("want empty, got %s", got)
	}
}

func TestStepUpRequiredNoKey(t *testing.T) {
	res := &OPAResult{
		Diagnostics: []map[string]interface{}{
			{"other_key": "value"},
		},
	}
	if got := stepUpRequired(res); got != "" {
		t.Errorf("want empty when key absent, got %s", got)
	}
}

func TestScopesAllowed(t *testing.T) {
	if !scopesAllowed([]string{"read"}, []string{"read", "write"}) {
		t.Error("expected read scope to be allowed")
	}
	if scopesAllowed([]string{"admin"}, []string{"read", "write"}) {
		t.Error("expected admin scope to be denied")
	}
	if !scopesAllowed(nil, []string{"read"}) {
		t.Error("expected empty requested scopes to be allowed")
	}
}

func TestTokenTTL(t *testing.T) {
	if got, err := tokenTTL(0, false); err != nil || got != ttlPerCallSDK {
		t.Errorf("want default TTL, got %v err=%v", got, err)
	}
	if got, err := tokenTTL(60, false); err != nil || got != time.Minute {
		t.Errorf("want 1m TTL, got %v err=%v", got, err)
	}
	if _, err := tokenTTL(int(ttlPerCallSDK.Seconds())+1, false); err == nil {
		t.Error("want error when TTL exceeds cap")
	}
	if got, err := tokenTTL(int(ttlAmbient.Seconds()), true); err != nil || got != ttlAmbient {
		t.Errorf("want ambient TTL, got %v err=%v", got, err)
	}
	if _, err := tokenTTL(-1, false); err == nil {
		t.Error("want error for negative TTL")
	}
}

func TestSameTokenPrincipal(t *testing.T) {
	if !sameTokenPrincipal(
		map[string]any{"sub": "user1", "client_id": "app1"},
		map[string]any{"sub": "user1", "client_id": "app1"},
	) {
		t.Fatal("matching subject and client must be same principal")
	}
	if sameTokenPrincipal(
		map[string]any{"sub": "user1", "client_id": "app1"},
		map[string]any{"sub": "user1", "client_id": "app2"},
	) {
		t.Fatal("different clients must be distinct principals")
	}
	if sameTokenPrincipal(
		map[string]any{"sub": "user1", "client_id": "app1"},
		map[string]any{"sub": "user2", "client_id": "app1"},
	) {
		t.Fatal("different subjects must be distinct principals")
	}
}

func TestBuildAuditEventFields(t *testing.T) {
	result := &OPAResult{
		Decision:         "allow",
		EvaluationStatus: "complete",
	}
	ev := buildAuditEvent("req-1", "zone-1", "allow", "complete", result, nil)

	if ev.RequestID != "req-1" {
		t.Errorf("want req-1, got %s", ev.RequestID)
	}
	if ev.ZoneID != "zone-1" {
		t.Errorf("want zone-1, got %s", ev.ZoneID)
	}
	if ev.Decision != "allow" {
		t.Errorf("want allow, got %s", ev.Decision)
	}
	if ev.EventType != "token_exchange" {
		t.Errorf("want token_exchange, got %s", ev.EventType)
	}
	if ev.ID == "" {
		t.Error("audit event ID must not be empty")
	}
	if ev.OccurredAt.IsZero() {
		t.Error("occurred_at must be set")
	}
	if time.Since(ev.OccurredAt) > time.Second {
		t.Error("occurred_at must be recent")
	}
}

func TestBuildAuditEventDeny(t *testing.T) {
	result := &OPAResult{
		Decision:         "deny",
		EvaluationStatus: "complete",
	}
	ev := buildAuditEvent("req-2", "zone-2", "deny", "complete", result, nil)
	if ev.Decision != "deny" {
		t.Errorf("want deny, got %s", ev.Decision)
	}
}

func TestBuildJWKSIncludesP256PublicKeyMetadata(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate signing key: %v", err)
	}
	body, err := BuildJWKS([]JWKSEntry{{Pub: &privateKey.PublicKey, Kid: "kid1"}})
	if err != nil {
		t.Fatalf("build jwks: %v", err)
	}

	var decoded struct {
		Keys []JWKSKey `json:"keys"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode jwks: %v", err)
	}
	if len(decoded.Keys) != 1 {
		t.Fatalf("want one jwks key, got %d", len(decoded.Keys))
	}
	key := decoded.Keys[0]
	if key.Kty != "EC" || key.Crv != "P-256" || key.Use != "sig" || key.Alg != "ES256" || key.Kid != "kid1" {
		t.Fatalf("unexpected jwks metadata: %#v", key)
	}
	if len(key.X) != 43 || len(key.Y) != 43 {
		t.Fatalf("want padded P-256 coordinates, got x=%q y=%q", key.X, key.Y)
	}
}

// stubDB satisfies DBQuerier with preset return values for the exchange path.
type stubDB struct {
	app           *Application
	appErr        error
	resource      *Resource
	resErr        error
	session       *Session
	sessionErr    error
	agentSessions []*AgentSession
	agentIndex    int
	agentErr      error
	edge          *DelegationEdge
	edges         map[string]*DelegationEdge
	edgeErr       error
	path          []string
	pathErr       error
	graphEpoch    int64
	epochErr      error
	sessErr       error
}

func (s *stubDB) Ping(_ context.Context) error { return nil }
func (s *stubDB) GetApplicationByID(_ context.Context, _, _ string) (*Application, error) {
	return s.app, s.appErr
}
func (s *stubDB) GetResourceByIdentifier(_ context.Context, _, _ string) (*Resource, error) {
	return s.resource, s.resErr
}
func (s *stubDB) GetDelegatedGrant(_ context.Context, _, _, _ string) (*DelegatedGrant, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) UpdateGrantTokens(_ context.Context, _ string, _ int, _, _ []byte, _ time.Time) error {
	return nil
}
func (s *stubDB) GetProvider(_ context.Context, _ string) (*ProviderConfig, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) GetDelegationEdge(_ context.Context, id string) (*DelegationEdge, error) {
	if s.edges != nil {
		if e, ok := s.edges[id]; ok {
			return e, s.edgeErr
		}
	}
	return s.edge, s.edgeErr
}
func (s *stubDB) GetResourceRateLimit(_ context.Context, _, _ string) (*ResourceRateLimit, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) GetSession(_ context.Context, _ string) (*Session, error) {
	return s.session, s.sessionErr
}
func (s *stubDB) GetAgentSession(_ context.Context, _ string) (*AgentSession, error) {
	if s.agentErr != nil {
		return nil, s.agentErr
	}
	if s.agentIndex >= len(s.agentSessions) {
		return nil, errors.New("stub")
	}
	session := s.agentSessions[s.agentIndex]
	s.agentIndex++
	return session, nil
}
func (s *stubDB) GetDelegationPath(_ context.Context, _, _, _ string, _ int) ([]string, error) {
	return s.path, s.pathErr
}
func (s *stubDB) GetDelegationGraphEpoch(_ context.Context, _ string) (int64, error) {
	return s.graphEpoch, s.epochErr
}
func (s *stubDB) InsertSession(_ context.Context, _ *Session) error  { return s.sessErr }
func (s *stubDB) RevokeSession(_ context.Context, _, _ string) error { return nil }
func (s *stubDB) GetStepUpChallenge(_ context.Context, _ string) (*StepUpChallengePG, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) InsertStepUpChallenge(_ context.Context, _ *StepUpChallengePG) error {
	return nil
}
func (s *stubDB) SatisfyStepUpChallenge(_ context.Context, _ string) error { return nil }
func (s *stubDB) ConsumeStepUpChallenge(_ context.Context, _ ConsumeStepUpParams) error {
	return nil
}
func (s *stubDB) GetZoneSigningKeySecret(_ context.Context, _ string) (*SecretRow, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) GetZoneSigningKeySecrets(_ context.Context, _ string) ([]SecretRow, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) GetActivePolicySetBinding(_ context.Context, _ string) (*PolicySetBinding, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) GetPolicySetVersion(_ context.Context, _ string) (*PolicySetVersion, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) GetPolicyVersionsByIDs(_ context.Context, _ []string) ([]PolicyVersion, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) ListBoundZoneIDs(_ context.Context) ([]string, error) { return nil, nil }
func (s *stubDB) UpdateApplicationSecretHash(_ context.Context, _, _, _ string) error {
	return nil
}

// TestExchangePartialDeny verifies that partial OPA evaluation status causes HTTP 403.
// This is the hard invariant: a partial result must never produce a token.
func TestExchangePartialDeny(t *testing.T) {
	credType := "confidential"
	hash, err := hashClientSecret("hunter2")
	if err != nil {
		t.Fatalf("hash secret: %v", err)
	}
	db := &stubDB{
		app: &Application{
			ID:                 "app1",
			ZoneID:             "zone1",
			Name:               "Test App",
			RegistrationMethod: "managed",
			CredentialType:     &credType,
			ClientSecretHash:   &hash,
		},
		resource: &Resource{
			ID:         "res1",
			ZoneID:     "zone1",
			Identifier: "https://api.example.com",
		},
	}

	partialPolicy := `
package caracal.authz
result := {"decision": "partial", "evaluation_status": "partial", "determining_policies": [], "diagnostics": []}
`
	opaEngine := newOPAEngine(nil)
	pq, err := rego.New(
		rego.Module("partial.rego", partialPolicy),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatalf("compile partial rego: %v", err)
	}
	opaEngine.mu.Lock()
	opaEngine.zones["zone1"] = &opaZoneState{query: &pq}
	opaEngine.mu.Unlock()

	srv := &Server{
		db:          db,
		opa:         opaEngine,
		auditBuffer: &AuditBuffer{ch: make(chan AuditEvent, 100)},
		cfg:         Config{IssuerURL: "https://sts.example.com"},
	}

	form := url.Values{
		"grant_type":        {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"zone_id":           {"zone1"},
		"application_id":    {"app1"},
		"client_assertion":  {"hunter2"},
		"resource":          {"https://api.example.com"},
	}
	req := httptest.NewRequest(http.MethodPost, "/oauth/2/token",
		strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()

	srv.handleTokenExchange(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("partial OPA status must yield HTTP 403, got %d", w.Code)
	}
}

func TestValidateSessionReferencesRequiresAgentSessionForDelegation(t *testing.T) {
	srv := &Server{db: &stubDB{}}
	_, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		DelegationEdgeID: "edge1",
	}, false)
	if err == nil || err.Description != "delegation edge requires source agent session" {
		t.Fatalf("want source agent session error, got %#v", err)
	}
}

func TestValidateSessionReferencesAcceptsActiveGraphEdge(t *testing.T) {
	now := time.Now()
	source := &AgentSession{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &AgentSession{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		agentSessions: []*AgentSession{source, target},
		path:          []string{"edge1"},
		graphEpoch:    7,
		edge: &DelegationEdge{
			ID:              "edge1",
			ZoneID:          "zone1",
			SourceSessionID: source.ID,
			TargetSessionID: target.ID,
			IssuerAppID:     source.ApplicationID,
			ReceiverAppID:   target.ApplicationID,
			Scopes:          []string{"read"},
			Status:          "active",
			ExpiresAt:       now.Add(time.Minute),
		},
	}
	srv := &Server{db: db}
	proof, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, false)
	if err != nil || proof == nil || proof.edge.ID != "edge1" || proof.graphEpoch != 7 {
		t.Fatalf("want active delegation proof, got proof=%#v err=%#v", proof, err)
	}
}

func TestValidateSessionReferencesRejectsDelegationBudget(t *testing.T) {
	now := time.Now()
	source := &AgentSession{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &AgentSession{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		agentSessions: []*AgentSession{source, target},
		path:          []string{"edge1"},
		edge: &DelegationEdge{
			ID:              "edge1",
			ZoneID:          "zone1",
			SourceSessionID: source.ID,
			TargetSessionID: target.ID,
			IssuerAppID:     source.ApplicationID,
			ReceiverAppID:   target.ApplicationID,
			Scopes:          []string{"read", "write"},
			Status:          "active",
			ExpiresAt:       now.Add(time.Minute),
			ConstraintsJSON: []byte(`{"budget":1,"max_hops":1}`),
		},
	}
	srv := &Server{db: db}
	_, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read write",
	}, false)
	if err == nil || err.Description != "requested scopes exceed delegation budget" {
		t.Fatalf("want budget error, got %#v", err)
	}
}

func TestValidateSessionReferencesRejectsDelegationTTLConstraint(t *testing.T) {
	now := time.Now()
	source := &AgentSession{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &AgentSession{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		agentSessions: []*AgentSession{source, target},
		path:          []string{"edge1"},
		edge: &DelegationEdge{
			ID:              "edge1",
			ZoneID:          "zone1",
			SourceSessionID: source.ID,
			TargetSessionID: target.ID,
			IssuerAppID:     source.ApplicationID,
			ReceiverAppID:   target.ApplicationID,
			Scopes:          []string{"read"},
			Status:          "active",
			ExpiresAt:       now.Add(time.Minute),
			ConstraintsJSON: []byte(`{"ttl_seconds":30}`),
		},
	}
	srv := &Server{db: db}
	_, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
		TTLSeconds:       60,
	}, false)
	if err == nil || err.Description != "requested ttl exceeds delegation ttl" {
		t.Fatalf("want ttl constraint error, got %#v", err)
	}
}

func TestValidateSessionReferencesRejectsMalformedDelegationConstraints(t *testing.T) {
	now := time.Now()
	source := &AgentSession{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &AgentSession{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		agentSessions: []*AgentSession{source, target},
		edge: &DelegationEdge{
			ID:              "edge1",
			ZoneID:          "zone1",
			SourceSessionID: source.ID,
			TargetSessionID: target.ID,
			IssuerAppID:     source.ApplicationID,
			ReceiverAppID:   target.ApplicationID,
			Scopes:          []string{"read"},
			Status:          "active",
			ExpiresAt:       now.Add(time.Minute),
			ConstraintsJSON: []byte(`{"max_hops":`),
		},
	}
	srv := &Server{db: db}
	_, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, false)
	if err == nil || err.Description != "delegation constraints invalid" {
		t.Fatalf("want malformed constraint error, got %#v", err)
	}
}

func TestExchangeRejectsResourceOutsideDelegationEdge(t *testing.T) {
	now := time.Now()
	credentialType := "confidential"
	hash, hashErr := hashClientSecret("hunter2")
	if hashErr != nil {
		t.Fatalf("hash secret: %v", hashErr)
	}
	boundResourceID := "res-bound"
	source := &AgentSession{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &AgentSession{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		app: &Application{
			ID:                 "app1",
			ZoneID:             "zone1",
			Name:               "Test App",
			RegistrationMethod: "managed",
			CredentialType:     &credentialType,
			ClientSecretHash:   &hash,
		},
		resource: &Resource{
			ID:         "res-other",
			ZoneID:     "zone1",
			Identifier: "resource://api/other",
			Scopes:     []string{"read"},
		},
		agentSessions: []*AgentSession{source, target},
		path:          []string{"edge1"},
		graphEpoch:    9,
		edge: &DelegationEdge{
			ID:              "edge1",
			ZoneID:          "zone1",
			SourceSessionID: source.ID,
			TargetSessionID: target.ID,
			IssuerAppID:     source.ApplicationID,
			ReceiverAppID:   target.ApplicationID,
			ResourceID:      &boundResourceID,
			Scopes:          []string{"read"},
			Status:          "active",
			ExpiresAt:       now.Add(time.Minute),
		},
	}
	srv := &Server{db: db}
	_, _, code, apiErr := srv.exchange(context.Background(), TokenExchangeRequest{
		ZoneID:           "zone1",
		ApplicationID:    "app1",
		ClientAssertion:  "hunter2",
		Resources:        []string{"resource://api/other"},
		Scope:            "read",
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
	}, "req-1")
	if code != http.StatusForbidden || apiErr == nil || apiErr.Description != "policy denied" {
		t.Fatalf("want soft-deny with no granted resources, code=%d err=%#v", code, apiErr)
	}
}

func TestValidateSessionReferencesRejectsInvalidDelegationPath(t *testing.T) {
	now := time.Now()
	source := &AgentSession{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &AgentSession{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		agentSessions: []*AgentSession{source, target},
		path:          []string{"other-edge"},
		edge: &DelegationEdge{
			ID:              "edge1",
			ZoneID:          "zone1",
			SourceSessionID: source.ID,
			TargetSessionID: target.ID,
			IssuerAppID:     source.ApplicationID,
			ReceiverAppID:   target.ApplicationID,
			Scopes:          []string{"read"},
			Status:          "active",
			ExpiresAt:       now.Add(time.Minute),
		},
	}
	srv := &Server{db: db, metrics: &STSMetrics{}}
	_, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, false)
	if err == nil || err.Description != "delegation path invalid" {
		t.Fatalf("want invalid path error, got %#v", err)
	}
	if got := srv.metrics.GraphTraversalErrors.Load(); got != 1 {
		t.Fatalf("want one graph traversal error, got %d", got)
	}
}

func TestValidateSessionReferencesRejectsMaxHopOverflow(t *testing.T) {
	now := time.Now()
	source := &AgentSession{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &AgentSession{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		agentSessions: []*AgentSession{source, target},
		path:          []string{"edge0", "edge1"},
		edge: &DelegationEdge{
			ID:              "edge1",
			ZoneID:          "zone1",
			SourceSessionID: source.ID,
			TargetSessionID: target.ID,
			IssuerAppID:     source.ApplicationID,
			ReceiverAppID:   target.ApplicationID,
			Scopes:          []string{"read"},
			Status:          "active",
			ExpiresAt:       now.Add(time.Minute),
			ConstraintsJSON: []byte(`{"max_hops":1}`),
		},
	}
	srv := &Server{db: db}
	_, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, false)
	if err == nil || err.Description != "delegation path invalid" {
		t.Fatalf("want max-hop path error, got %#v", err)
	}
}

func TestValidateSessionReferencesAcceptsDeepDelegationPath(t *testing.T) {
	now := time.Now()
	source := &AgentSession{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &AgentSession{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		SpawnedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	edges := map[string]*DelegationEdge{
		"edge0": {
			ID: "edge0", ZoneID: "zone1",
			SourceSessionID: source.ID, TargetSessionID: "agent-mid1",
			IssuerAppID: "app1", ReceiverAppID: "appA",
			Status: "active", ExpiresAt: now.Add(time.Minute),
		},
		"edge2": {
			ID: "edge2", ZoneID: "zone1",
			SourceSessionID: "agent-mid1", TargetSessionID: target.ID,
			IssuerAppID: "appA", ReceiverAppID: "app2",
			Status: "active", ExpiresAt: now.Add(time.Minute),
		},
	}
	edge1 := &DelegationEdge{
		ID:              "edge1",
		ZoneID:          "zone1",
		SourceSessionID: source.ID,
		TargetSessionID: target.ID,
		IssuerAppID:     source.ApplicationID,
		ReceiverAppID:   target.ApplicationID,
		Scopes:          []string{"read"},
		Status:          "active",
		ExpiresAt:       now.Add(time.Minute),
		ConstraintsJSON: []byte(`{"max_hops":3}`),
	}
	edges["edge1"] = edge1
	db := &stubDB{
		agentSessions: []*AgentSession{source, target},
		path:          []string{"edge1"},
		graphEpoch:    12,
		edge:          edge1,
		edges:         edges,
	}
	srv := &Server{db: db}
	proof, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, false)
	if err != nil || proof == nil || len(proof.path) != 1 || proof.graphEpoch != 12 {
		t.Fatalf("want delegation proof, got proof=%#v err=%#v", proof, err)
	}
	if len(proof.chain) != 2 || proof.chain[0].AppID != "app1" || proof.chain[1].AppID != "app2" {
		t.Fatalf("want 2-hop chain, got %#v", proof.chain)
	}
}

func TestDelegationPolicyEvaluationLoad(t *testing.T) {
	policy := `package caracal.authz

import rego.v1

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "delegation-load"}], "diagnostics": []} if {
  count(input.delegation_edge.path) == 3
  input.context.agent_session_id == input.delegation_edge.source_session_id
  every scope in input.context.requested_scopes {
    scope in input.delegation_edge.scopes
  }
}`
	opaEngine := newOPAEngine(nil)
	pq, err := rego.New(
		rego.Module("delegation-load.rego", policy),
		rego.Query("result = data.caracal.authz.result"),
	).PrepareForEval(context.Background())
	if err != nil {
		t.Fatalf("compile delegation load policy: %v", err)
	}
	opaEngine.mu.Lock()
	opaEngine.zones["zone1"] = &opaZoneState{query: &pq}
	opaEngine.mu.Unlock()
	input := OPAInput{
		Principal: OPAPrincipal{ID: "app1", ZoneID: "zone1"},
		Resource:  OPAResource{Type: "api", ID: "res1", Identifier: "https://api.example.com", Scopes: []string{"read"}},
		Action:    OPAAction{ID: "TokenExchange"},
		DelegationEdge: &OPADelegationEdge{
			ID:              "edge1",
			SourceSessionID: "agent-src",
			TargetSessionID: "agent-dst",
			Scopes:          []string{"read"},
			Path:            []string{"edge0", "edge1", "edge2"},
			GraphEpoch:      12,
		},
		Context: OPAContext{
			ActorClaims:     map[string]interface{}{"sub": "app1"},
			AgentSessionID:  "agent-src",
			RequestedScopes: []string{"read"},
		},
	}
	for iteration := 0; iteration < 250; iteration++ {
		result, err := opaEngine.Evaluate(context.Background(), input)
		if err != nil {
			t.Fatalf("evaluate delegation policy iteration %d: %v", iteration, err)
		}
		if result.Decision != "allow" || result.EvaluationStatus != "complete" {
			t.Fatalf("want allow complete at iteration %d, got %#v", iteration, result)
		}
	}
	if got := opaEngine.MetricsSnapshot().EvalTotal; got != 250 {
		t.Fatalf("want 250 OPA evaluations, got %d", got)
	}
}
