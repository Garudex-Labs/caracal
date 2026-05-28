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
	"testing"
	"time"

	"github.com/open-policy-agent/opa/rego"
)

func strPtr(value string) *string {
	return &value
}

func testProviderSecret(t *testing.T, zek []byte, config string) ([]byte, []byte) {
	t.Helper()
	ct, nonce, err := sharedcrypto.Seal(zek, []byte(config))
	if err != nil {
		t.Fatalf("seal provider secret: %v", err)
	}
	return ct, nonce
}

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
		Diagnostics: []map[string]any{
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
		Diagnostics: []map[string]any{
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
	if got, err := tokenTTL(0, false); err != nil || got != ttlResourceMandate {
		t.Errorf("want default TTL, got %v err=%v", got, err)
	}
	if got, err := tokenTTL(60, false); err != nil || got != time.Minute {
		t.Errorf("want 1m TTL, got %v err=%v", got, err)
	}
	if _, err := tokenTTL(int(ttlResourceMandate.Seconds())+1, false); err == nil {
		t.Error("want error when TTL exceeds cap")
	}
	if got, err := tokenTTL(int(ttlSessionMandate.Seconds()), true); err != nil || got != ttlSessionMandate {
		t.Errorf("want session mandate TTL, got %v err=%v", got, err)
	}
	if _, err := tokenTTL(-1, false); err == nil {
		t.Error("want error for negative TTL")
	}
}

func TestRootSessionIDTracksAuthorityRoot(t *testing.T) {
	if got := rootSessionID(nil, "session-1", UseSession); got != "session-1" {
		t.Fatalf("session mandate root should be its own sid, got %q", got)
	}
	claims := map[string]any{"sid": "session-1"}
	if got := rootSessionID(claims, "resource-1", UseResource); got != "session-1" {
		t.Fatalf("resource mandate root should default to parent sid, got %q", got)
	}
	claims["root_sid"] = "root-1"
	if got := rootSessionID(claims, "resource-1", UseResource); got != "root-1" {
		t.Fatalf("resource mandate root should preserve inherited root, got %q", got)
	}
}

func TestParentSessionIDOnlyForDerivedTokens(t *testing.T) {
	if got := parentSessionID("session-1", UseSession); got != nil {
		t.Fatalf("session mandates must not have a parent, got %q", *got)
	}
	got := parentSessionID("session-1", UseResource)
	if got == nil || *got != "session-1" {
		t.Fatalf("resource mandates must link to parent session mandate, got %#v", got)
	}
}

func TestBuildAuditEventFields(t *testing.T) {
	result := &OPAResult{
		Decision:         "allow",
		EvaluationStatus: "complete",
	}
	ev, err := buildAuditEvent("req-1", "zone-1", "allow", "complete", result, nil)
	if err != nil {
		t.Fatal(err)
	}

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
	ev, err := buildAuditEvent("req-2", "zone-2", "deny", "complete", result, nil)
	if err != nil {
		t.Fatal(err)
	}
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
	grant         *ProviderGrant
	grantErr      error
	provider      *ProviderConfig
	session       *Session
	sessionErr    error
	agentSessions []*AgentSession
	agentIndex    int
	agentErr      error
	edge          *DelegationEdge
	edgeErr       error
	edgesMap      map[string]*DelegationEdge
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
func (s *stubDB) GetProviderGrant(_ context.Context, _, _, _ string, providerID *string) (*ProviderGrant, error) {
	if s.grantErr != nil {
		return nil, s.grantErr
	}
	if s.grant != nil {
		if providerID != nil && (s.grant.ProviderID == nil || *s.grant.ProviderID != *providerID) {
			return nil, errors.New("stub: provider mismatch")
		}
		return s.grant, nil
	}
	return nil, errors.New("stub")
}
func (s *stubDB) UpdateProviderGrantTokens(_ context.Context, _ string, _ int, _, _ []byte, _ time.Time) error {
	return nil
}
func (s *stubDB) GetProvider(_ context.Context, _ string) (*ProviderConfig, error) {
	if s.provider != nil {
		return s.provider, nil
	}
	return nil, errors.New("stub")
}
func (s *stubDB) GetDelegationEdge(_ context.Context, id string) (*DelegationEdge, error) {
	if s.edgesMap != nil {
		if e, ok := s.edgesMap[id]; ok {
			return e, nil
		}
		return nil, errors.New("stub: edge not found")
	}
	return s.edge, s.edgeErr
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
func (s *stubDB) EnsureZoneSigningKeySecret(_ context.Context, _ string, _, _ []byte) (*SecretRow, error) {
	return nil, errors.New("stub")
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

func TestValidateTokenSessionBindsClientID(t *testing.T) {
	subjectID := "user-1"
	srv := &Server{db: &stubDB{session: &Session{
		ID:        "sess-1",
		ZoneID:    "zone1",
		Status:    "active",
		SubjectID: &subjectID,
		ExpiresAt: time.Now().Add(time.Minute),
	}}}
	claims := map[string]any{
		"sid":       "sess-1",
		"sub":       subjectID,
		"client_id": "app1",
	}
	if sid, err := srv.validateTokenSession(context.Background(), "zone1", "app1", "", claims); err != nil || sid != "sess-1" {
		t.Fatalf("matching client_id must pass, sid=%q err=%#v", sid, err)
	}
	if _, err := srv.validateTokenSession(context.Background(), "zone1", "app2", "", claims); err == nil || err.Description != "session client mismatch" {
		t.Fatalf("wrong client_id must fail, got %#v", err)
	}
}

func TestAuthenticateAppAllowsSignedGatewayExchangeWithoutClientSecret(t *testing.T) {
	srv := &Server{db: &stubDB{app: &Application{
		ID:                 "app1",
		ZoneID:             "zone1",
		Name:               "Test App",
		RegistrationMethod: "managed",
	}}}
	app, zoneID, err := srv.authenticateApp(context.Background(), TokenExchangeRequest{
		ZoneID:               "zone1",
		ApplicationID:        "app1",
		SubjectToken:         "session-mandate",
		GatewayAuthenticated: true,
	})
	if err != nil || app.ID != "app1" || zoneID != "zone1" {
		t.Fatalf("gateway-authenticated exchange should not require client secret, app=%#v zone=%q err=%v", app, zoneID, err)
	}
}

func TestAuthenticateAppRejectsGatewayBootstrapWithoutSubjectToken(t *testing.T) {
	srv := &Server{db: &stubDB{app: &Application{
		ID:                 "app1",
		ZoneID:             "zone1",
		Name:               "Test App",
		RegistrationMethod: "managed",
	}}}
	if _, _, err := srv.authenticateApp(context.Background(), TokenExchangeRequest{
		ZoneID:               "zone1",
		ApplicationID:        "app1",
		GatewayAuthenticated: true,
	}); err == nil {
		t.Fatalf("gateway-authenticated exchanges must not bootstrap session mandates")
	}
}

func TestBuildUpstreamDirectiveHidesProviderTokenFromPublicExchange(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	srv := &Server{db: &stubDB{}}
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, false)
	if err != nil {
		t.Fatalf("public directive should not require provider token: %v", err)
	}
	if directive.ProviderToken != "" || directive.AuthMode != UpstreamAuthCaracalJWT {
		t.Fatalf("public exchange must not expose provider token, got %#v", directive)
	}
}

func TestBuildUpstreamDirectiveIncludesProviderTokenOnlyForGateway(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	token, err := sealZEK(zek, []byte("provider-access-token"))
	if err != nil {
		t.Fatalf("seal provider token: %v", err)
	}
	expiresAt := time.Now().Add(time.Minute)
	srv := &Server{
		db: &stubDB{
			grant:    &ProviderGrant{ProviderID: &providerID, AccessTokenCt: token, ExpiresAt: &expiresAt},
			provider: &ProviderConfig{ID: providerID, ProviderKind: strPtr("oauth2_authorization_code")},
		},
		keys: &KeyCache{zek: zek},
	}
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true)
	if err != nil {
		t.Fatalf("gateway directive should decrypt provider token: %v", err)
	}
	if directive.ProviderToken != "provider-access-token" || directive.AuthMode != UpstreamAuthProviderOAuth {
		t.Fatalf("gateway exchange must receive brokered provider token, got %#v", directive)
	}
}

func TestBuildUpstreamDirectiveBindsGrantToConfiguredProvider(t *testing.T) {
	providerID := "provider1"
	otherProviderID := "provider2"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	token, err := sealZEK(zek, []byte("provider-access-token"))
	if err != nil {
		t.Fatalf("seal provider token: %v", err)
	}
	srv := &Server{
		db:   &stubDB{grant: &ProviderGrant{ProviderID: &otherProviderID, AccessTokenCt: token}},
		keys: &KeyCache{zek: zek},
	}
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true); err == nil {
		t.Fatal("gateway directive must reject grants from a different provider")
	}
}

func TestBuildUpstreamDirectiveSupportsAPIKeyProviderShape(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	secretCt, secretNonce := testProviderSecret(t, zek, `{"api_key":"api-key-value"}`)
	srv := &Server{
		db: &stubDB{
			provider: &ProviderConfig{
				ID:                providerID,
				ProviderKind:      strPtr("api_key"),
				ConfigJSON:        []byte(`{"header_name":"X-Api-Key"}`),
				SecretConfigCt:    secretCt,
				SecretConfigNonce: secretNonce,
			},
		},
		keys: &KeyCache{zek: zek},
	}
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true)
	if err != nil {
		t.Fatalf("gateway directive should support API key provider shape: %v", err)
	}
	if directive.AuthMode != UpstreamAuthProviderAPIKey || directive.AuthHeader != "X-Api-Key" || directive.AuthScheme != "" || directive.ProviderToken != "api-key-value" {
		t.Fatalf("unexpected apikey directive: %#v", directive)
	}
}

func TestBuildUpstreamDirectiveReadsIdentityForwardingOptIn(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	secretCt, secretNonce := testProviderSecret(t, zek, `{"api_key":"api-key-value"}`)
	srv := &Server{
		db: &stubDB{
			provider: &ProviderConfig{
				ID:                providerID,
				ProviderKind:      strPtr("api_key"),
				ConfigJSON:        []byte(`{"header_name":"X-Api-Key","forward_caracal_identity":true}`),
				SecretConfigCt:    secretCt,
				SecretConfigNonce: secretNonce,
			},
		},
		keys: &KeyCache{zek: zek},
	}
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true)
	if err != nil {
		t.Fatalf("gateway directive should support identity forwarding opt-in: %v", err)
	}
	if !directive.ForwardCaracalIdentity {
		t.Fatalf("identity forwarding opt-in not propagated: %#v", directive)
	}
}

func TestBuildUpstreamDirectiveRejectsAPIKeyWithoutHeader(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	secretCt, secretNonce := testProviderSecret(t, zek, `{"api_key":"api-key-value"}`)
	srv := &Server{
		db: &stubDB{
			provider: &ProviderConfig{
				ID:                providerID,
				ProviderKind:      strPtr("api_key"),
				ConfigJSON:        []byte(`{}`),
				SecretConfigCt:    secretCt,
				SecretConfigNonce: secretNonce,
			},
		},
		keys: &KeyCache{zek: zek},
	}
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true); err == nil {
		t.Fatal("apikey provider directive must require an explicit auth header")
	}
}

func TestBuildUpstreamDirectiveRejectsMalformedProviderConfig(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	token, err := sealZEK(zek, []byte("provider-access-token"))
	if err != nil {
		t.Fatalf("seal provider token: %v", err)
	}
	srv := &Server{
		db: &stubDB{
			grant: &ProviderGrant{ProviderID: &providerID, AccessTokenCt: token},
			provider: &ProviderConfig{
				ID:           providerID,
				ProviderKind: strPtr("oauth2_authorization_code"),
				ConfigJSON:   []byte(`{bad json`),
			},
		},
		keys: &KeyCache{zek: zek},
	}
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true); err == nil {
		t.Fatal("provider directive must reject malformed provider config")
	}
}

// TestExchangePartialDeny verifies that partial OPA evaluation status causes HTTP 403.
// This is the hard invariant: a partial result must never produce a token.
func TestExchangePartialDeny(t *testing.T) {
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	db := &stubDB{
		app: &Application{
			ID:                 "app1",
			ZoneID:             "zone1",
			Name:               "Test App",
			RegistrationMethod: "managed",
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
result := {"decision": "deny", "evaluation_status": "partial", "determining_policies": [], "diagnostics": []}
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

	_, _, code, _ := srv.exchange(context.Background(), TokenExchangeRequest{
		GrantType:     "urn:ietf:params:oauth:grant-type:token-exchange",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		ClientSecret:  "test-secret",
		Resources:     []string{"https://api.example.com"},
	}, "req-partial")

	if code != http.StatusForbidden {
		t.Errorf("partial OPA status must yield HTTP 403, got %d", code)
	}
}

func TestValidateSessionReferencesRequiresAgentSessionForDelegation(t *testing.T) {
	srv := &Server{db: &stubDB{}}
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		DelegationEdgeID: "edge1",
	}, true)
	if err == nil || err.Description != "delegation edge requires target agent session" {
		t.Fatalf("want target agent session error, got %#v", err)
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
	proof, agentSession, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err != nil || proof == nil || proof.edge.ID != "edge1" || proof.graphEpoch != 7 {
		t.Fatalf("want active delegation proof, got proof=%#v err=%#v", proof, err)
	}
	if agentSession == nil || agentSession.ID != target.ID {
		t.Fatalf("target agent session not returned for policy input: %#v", agentSession)
	}
}

func TestAgentSessionMetadataIsPolicyAndAuditInput(t *testing.T) {
	session := &AgentSession{
		ID:           "agent-1",
		Kind:         "ephemeral",
		Capabilities: []string{"browser", "code"},
	}
	if got := agentSessionKind(session); got != "ephemeral" {
		t.Fatalf("kind = %q", got)
	}
	caps := agentSessionCapabilities(session)
	caps[0] = "mutated"
	if session.Capabilities[0] != "browser" {
		t.Fatal("capabilities must be copied before policy evaluation")
	}
	meta := agentAuditMeta(session)
	if meta["agent_kind"] != "ephemeral" {
		t.Fatalf("audit metadata missing kind: %#v", meta)
	}
	gotCaps, ok := meta["agent_capabilities"].([]string)
	if !ok || len(gotCaps) != 2 || gotCaps[1] != "code" {
		t.Fatalf("audit metadata missing capabilities: %#v", meta)
	}
}

func TestEffectiveTokenTTLCapsAtDelegationExpiry(t *testing.T) {
	now := time.Now()
	ttl, err := effectiveTokenTTL(10*time.Minute, &delegationProof{
		edge: &DelegationEdge{ExpiresAt: now.Add(30 * time.Second)},
	}, now)
	if err != nil {
		t.Fatalf("effective ttl should cap: %v", err)
	}
	if ttl > 31*time.Second {
		t.Fatalf("ttl not capped by delegation expiry: %s", ttl)
	}
}

func TestEffectiveTokenTTLCapsAtDelegationConstraint(t *testing.T) {
	now := time.Now()
	ttl, err := effectiveTokenTTL(10*time.Minute, &delegationProof{
		edge:        &DelegationEdge{ExpiresAt: now.Add(time.Hour)},
		constraints: delegationConstraints{TTLSeconds: 45},
	}, now)
	if err != nil {
		t.Fatalf("effective ttl should cap: %v", err)
	}
	if ttl != 45*time.Second {
		t.Fatalf("ttl = %s, want 45s", ttl)
	}
}

func TestBindSubjectAgentSessionCopiesSignedClaim(t *testing.T) {
	req := TokenExchangeRequest{}
	err := bindSubjectAgentSession(&req, map[string]any{"agent_session_id": "agent-1"})
	if err != nil {
		t.Fatalf("bind signed agent session: %v", err)
	}
	if req.AgentSessionID != "agent-1" {
		t.Fatalf("agent session id = %q, want agent-1", req.AgentSessionID)
	}
}

func TestBindSubjectAgentSessionRejectsMismatch(t *testing.T) {
	req := TokenExchangeRequest{AgentSessionID: "agent-2"}
	err := bindSubjectAgentSession(&req, map[string]any{"agent_session_id": "agent-1"})
	if err == nil || err.Description != "agent session mismatch" {
		t.Fatalf("want mismatch error, got %#v", err)
	}
}

func TestValidateSessionReferencesRejectsSourceUsingDelegationEdge(t *testing.T) {
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
		},
	}
	srv := &Server{db: db}
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AgentSessionID:   source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err == nil || err.Description != "delegation edge target mismatch" {
		t.Fatalf("source agent must not consume target delegation edge, got %#v", err)
	}
}

func TestValidateSessionReferencesRejectsUnrelatedAppUsingDelegationEdge(t *testing.T) {
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
		},
	}
	srv := &Server{db: db}
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app3", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err == nil || err.Description != "delegation target inactive or unauthorized" {
		t.Fatalf("unrelated app must not consume target delegation edge, got %#v", err)
	}
}

func TestValidateSessionReferencesRejectsExpiredDelegationEdge(t *testing.T) {
	now := time.Now()
	db := &stubDB{
		edge: &DelegationEdge{
			ID:              "edge1",
			ZoneID:          "zone1",
			SourceSessionID: "agent-src",
			TargetSessionID: "agent-dst",
			IssuerAppID:     "app1",
			ReceiverAppID:   "app2",
			Scopes:          []string{"read"},
			Status:          "active",
			ExpiresAt:       now.Add(-time.Second),
		},
	}
	srv := &Server{db: db}
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   "agent-dst",
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err == nil || err.Description != "delegation edge inactive or expired" {
		t.Fatalf("expired edge must fail, got %#v", err)
	}
}

func TestValidateSessionReferencesRejectsScopeOutsideDelegationEdge(t *testing.T) {
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
		},
	}
	srv := &Server{db: db}
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "write",
	}, true)
	if err == nil || err.Description != "requested scopes exceed delegation scopes" {
		t.Fatalf("scope outside delegation must fail, got %#v", err)
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
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read write",
	}, true)
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
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
		TTLSeconds:       60,
	}, true)
	if err == nil || err.Description != "requested ttl exceeds delegation ttl" {
		t.Fatalf("want ttl constraint error, got %#v", err)
	}

	db.agentIndex = 0
	proof, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err != nil || proof == nil || proof.constraints.TTLSeconds != 30 {
		t.Fatalf("default ttl should be capped at issuance instead of rejected, proof=%#v err=%#v", proof, err)
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
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err == nil || err.Description != "delegation constraints invalid" {
		t.Fatalf("want malformed constraint error, got %#v", err)
	}
}

func TestExchangeRejectsResourceOutsideDelegationEdge(t *testing.T) {
	now := time.Now()
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
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
			ID:                 "app2",
			ZoneID:             "zone1",
			Name:               "Test App",
			RegistrationMethod: "managed",
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
	srv := &Server{db: db, auditBuffer: &AuditBuffer{ch: make(chan AuditEvent, 100)}}
	_, _, code, apiErr := srv.exchange(context.Background(), TokenExchangeRequest{
		ZoneID:           "zone1",
		ApplicationID:    "app2",
		ClientSecret:     "test-secret",
		Resources:        []string{"resource://api/other"},
		Scope:            "read",
		AgentSessionID:   target.ID,
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
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
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
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
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
	mainEdge := &DelegationEdge{
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
	// Build a valid 3-edge chain: app1→app1 (edge0), app1→app2 (edge1), app2→app2 (edge2).
	// Continuity: each edge's IssuerAppID must equal the previous edge's ReceiverAppID.
	db := &stubDB{
		agentSessions: []*AgentSession{source, target},
		path:          []string{"edge0", "edge1", "edge2"},
		graphEpoch:    12,
		edge:          mainEdge,
		edgesMap: map[string]*DelegationEdge{
			"edge0": {
				ID:              "edge0",
				ZoneID:          "zone1",
				SourceSessionID: source.ID,
				TargetSessionID: source.ID,
				IssuerAppID:     "app1",
				ReceiverAppID:   "app1",
				Status:          "active",
				ExpiresAt:       now.Add(time.Minute),
			},
			"edge1": mainEdge,
			"edge2": {
				ID:              "edge2",
				ZoneID:          "zone1",
				SourceSessionID: target.ID,
				TargetSessionID: target.ID,
				IssuerAppID:     "app2",
				ReceiverAppID:   "app2",
				Status:          "active",
				ExpiresAt:       now.Add(time.Minute),
			},
		},
	}
	srv := &Server{db: db}
	proof, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		AgentSessionID:   target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err != nil || proof == nil || len(proof.path) != 3 || proof.graphEpoch != 12 {
		t.Fatalf("want deep delegation proof, got proof=%#v err=%#v", proof, err)
	}
}

func TestDelegationPolicyEvaluationLoad(t *testing.T) {
	policy := `package caracal.authz

import rego.v1

result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [{"policy": "delegation-load"}], "diagnostics": []} if {
  count(input.delegation_edge.path) == 3
  input.context.agent_session_id == input.delegation_edge.target_session_id
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
		Principal: OPAPrincipal{ID: "app2", ZoneID: "zone1"},
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
			ActorClaims:     map[string]any{"sub": "app2"},
			AgentSessionID:  "agent-dst",
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
