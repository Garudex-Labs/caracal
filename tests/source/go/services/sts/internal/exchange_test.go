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
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/open-policy-agent/opa/rego"
)

func TestTokenExchangeErrorIncludesGeneratedRequestID(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/oauth/2/token", strings.NewReader("%"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	(&Server{}).handleTokenExchange(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	requestID := w.Header().Get("X-Request-Id")
	if requestID == "" || !strings.Contains(w.Body.String(), `"requestId":"`+requestID+`"`) {
		t.Fatalf("expected generated request id in header and body, header=%q body=%s", requestID, w.Body.String())
	}
}

func TestTokenExchangeRejectsUnsupportedOAuthParameters(t *testing.T) {
	for _, tc := range []struct {
		name string
		form url.Values
	}{
		{name: "grant", form: url.Values{"grant_type": {"client_credentials"}}},
		{name: "subject type", form: url.Values{
			"grant_type":         {tokenExchangeGrantType},
			"subject_token":      {"token"},
			"subject_token_type": {"urn:unsupported"},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/oauth/2/token", strings.NewReader(tc.form.Encode()))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			w := httptest.NewRecorder()
			(&Server{}).handleTokenExchange(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestTokenExchangeRequiresBodyOnlyFormEncoding(t *testing.T) {
	for _, tc := range []struct {
		name        string
		target      string
		contentType string
		body        string
		status      int
	}{
		{name: "query", target: "/oauth/2/token?resource=resource%3A%2F%2Fpipernet", contentType: "application/x-www-form-urlencoded", status: http.StatusBadRequest},
		{name: "content type", target: "/oauth/2/token", contentType: "application/json", body: `{}`, status: http.StatusUnsupportedMediaType},
		{name: "duplicate singleton", target: "/oauth/2/token", contentType: "application/x-www-form-urlencoded", body: "zone_id=z1&zone_id=z2", status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tc.target, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			w := httptest.NewRecorder()
			(&Server{}).handleTokenExchange(w, req)
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestTokenExchangeRejectsClientAssertionAuthentication(t *testing.T) {
	for _, field := range []string{"client_assertion", "client_assertion_type"} {
		t.Run(field, func(t *testing.T) {
			form := url.Values{"grant_type": {tokenExchangeGrantType}, field: {"value"}}
			req := httptest.NewRequest(http.MethodPost, "/oauth/2/token", strings.NewReader(form.Encode()))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			w := httptest.NewRecorder()
			(&Server{}).handleTokenExchange(w, req)
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "not supported") {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestCanonicalResourceSet(t *testing.T) {
	resources, err := canonicalResourceSet([]string{" resource://pipernet ", "resource://hoolibox", "resource://pipernet"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(resources, []string{"resource://hoolibox", "resource://pipernet"}) {
		t.Fatalf("resources=%v", resources)
	}
	if _, err := canonicalResourceSet([]string{""}); err == nil {
		t.Fatal("empty resource must fail")
	}
}

func strPtr(value string) *string {
	return &value
}

// testProviderSecret seals a provider credential document the way the control plane
// does: a CSS1 envelope bound to the provider's Secret Store ref.
func testProviderSecret(t *testing.T, kek []byte, providerID, config string) map[string][]byte {
	t.Helper()
	ref := secretstore.ProviderSecretConfigRef("", providerID)
	envelope, err := secretstore.Seal(kek, []byte(config), ref)
	if err != nil {
		t.Fatalf("seal provider secret: %v", err)
	}
	return map[string][]byte{ref: envelope}
}

// providerServer wires a Server the way newServer does for provider credential
// paths: builtin secret backend over the same test double and KEK.
func providerServer(db *stubDB, kek []byte) *Server {
	return &Server{
		db:      db,
		keys:    &KeyCache{keyring: testKeyring(kek)},
		secrets: secretstore.Opened(&builtinSecretBackend{db: db}, testKeyring(kek)),
	}
}

func sealConnectionToken(t *testing.T, kek []byte, token string) []byte {
	t.Helper()
	envelope, err := secretstore.Seal(kek, []byte(token), secretstore.AADConnectionAccessToken)
	if err != nil {
		t.Fatalf("seal provider token: %v", err)
	}
	return envelope
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

func TestParseTierDeclarations(t *testing.T) {
	res := &OPAResult{
		Diagnostics: []map[string]any{
			{"step_up_required": map[string]any{
				"type": "human_approval",
				"tiers": []any{
					map[string]any{"tier": "money", "approver": "operator", "ttl_seconds": float64(600), "privacy": "anonymous"},
					map[string]any{"tier": "pii"},
					map[string]any{"approver": "subject"},
				},
			}},
		},
	}
	decls := parseTierDeclarations(res)
	if len(decls) != 2 {
		t.Fatalf("tierless entries must be skipped, got %+v", decls)
	}
	if decls[0].Tier != "money" || decls[0].Approver != "operator" || decls[0].TTLSeconds != 600 || decls[0].Privacy != "anonymous" {
		t.Fatalf("full declaration mis-parsed: %+v", decls[0])
	}
	if decls[1].Tier != "pii" || decls[1].Approver != "" || decls[1].TTLSeconds != 0 {
		t.Fatalf("minimal declaration mis-parsed: %+v", decls[1])
	}
}

func TestParseTierDeclarationsNone(t *testing.T) {
	if got := parseTierDeclarations(&OPAResult{Diagnostics: nil}); got != nil {
		t.Errorf("want none, got %+v", got)
	}
	if got := parseTierDeclarations(&OPAResult{Diagnostics: []map[string]any{{"other_key": "value"}}}); got != nil {
		t.Errorf("want none when key absent, got %+v", got)
	}
}

func TestResolveApprovalMergesCompatibleDeclarations(t *testing.T) {
	got, err := resolveApproval([]tierDeclaration{
		{Tier: "money", Approver: "subject", TTLSeconds: 600, Privacy: "identified"},
		{Tier: "pii", Approver: "any", TTLSeconds: 7200, Privacy: "anonymous"},
		{Tier: "money", Approver: "any"},
	})
	if err != nil {
		t.Fatalf("resolve compatible declarations: %v", err)
	}
	if got.Tier != "money,pii" {
		t.Errorf("tiers must join sorted and deduplicated, got %q", got.Tier)
	}
	if got.Approver != ApproverClassSubject {
		t.Errorf("subject demand must win over any, got %q", got.Approver)
	}
	if got.TTL != 600*time.Second {
		t.Errorf("shortest declared window must win, got %v", got.TTL)
	}
	if got.Privacy != PrivacyAnonymous {
		t.Errorf("most protective privacy must win, got %q", got.Privacy)
	}
}

func TestResolveApprovalRejectsIndependentApproverClasses(t *testing.T) {
	_, err := resolveApproval([]tierDeclaration{
		{Tier: "money", Approver: "subject"},
		{Tier: "operations", Approver: "operator"},
	})
	if !errors.Is(err, ErrApprovalClassConflict) {
		t.Fatalf("want approver class conflict, got %v", err)
	}
}

func TestResolveApprovalDefaultsAndClamps(t *testing.T) {
	got, err := resolveApproval([]tierDeclaration{{Tier: "money"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Approver != ApproverClassOperator || got.Privacy != PrivacyIdentified || got.TTL != approvalDefaultTTL {
		t.Errorf("absent fields must take platform defaults, got %+v", got)
	}
	invalid, err := resolveApproval([]tierDeclaration{{Tier: "money", Approver: "root", Privacy: "secret", TTLSeconds: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if invalid.Approver != ApproverClassOperator || invalid.Privacy != PrivacyIdentified {
		t.Errorf("invalid enum values must take platform defaults, got %+v", invalid)
	}
	if invalid.TTL != approvalMinTTL {
		t.Errorf("ttl must clamp to the floor, got %v", invalid.TTL)
	}
	ceil, err := resolveApproval([]tierDeclaration{{Tier: "money", TTLSeconds: int((30 * 24 * time.Hour).Seconds())}})
	if err != nil {
		t.Fatal(err)
	}
	if ceil.TTL != approvalMaxTTL {
		t.Errorf("ttl must clamp to the ceiling, got %v", ceil.TTL)
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
	if got, err := tokenTTL(int(ttlAuthorityRecordMandate.Seconds()), true); err != nil || got != ttlAuthorityRecordMandate {
		t.Errorf("want session mandate TTL, got %v err=%v", got, err)
	}
	if _, err := tokenTTL(-1, false); err == nil {
		t.Error("want error for negative TTL")
	}
}

func TestRootAuthorityRecordIDTracksAuthorityRoot(t *testing.T) {
	if got := rootAuthorityRecordID(nil, "session-1", UseSession); got != "session-1" {
		t.Fatalf("session mandate root should be its own sid, got %q", got)
	}
	claims := map[string]any{"sid": "session-1"}
	if got := rootAuthorityRecordID(claims, "resource-1", UseResource); got != "session-1" {
		t.Fatalf("resource mandate root should default to parent sid, got %q", got)
	}
	claims["root_sid"] = "root-1"
	if got := rootAuthorityRecordID(claims, "resource-1", UseResource); got != "root-1" {
		t.Fatalf("resource mandate root should preserve inherited root, got %q", got)
	}
}

func TestParentAuthorityRecordIDOnlyForDerivedTokens(t *testing.T) {
	if got := parentAuthorityRecordID("session-1", UseSession); got != nil {
		t.Fatalf("session mandates must not have a parent, got %q", *got)
	}
	got := parentAuthorityRecordID("session-1", UseResource)
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
	app                      *Application
	appErr                   error
	appGlobal                *Application
	subjectIssuer            *SubjectIssuer
	insertedAuthorityRecords []*AuthorityRecord
	appGlobalErr             error
	resource                 *Resource
	resErr                   error
	grant                    *ProviderConnection
	grantErr                 error
	provider                 *ProviderConfig
	session                  *AuthorityRecord
	sessionErr               error
	sessions                 []*Session
	agentIndex               int
	agentErr                 error
	edge                     *DelegationEdge
	edgeErr                  error
	edgesMap                 map[string]*DelegationEdge
	path                     []string
	pathErr                  error
	graphEpoch               int64
	epochErr                 error
	sessErr                  error
	secrets                  []SecretRow
	secretsErr               error
	insertedKey              *SecretRow
	storeEnvelopes           map[string][]byte
	now                      time.Time
	workload                 *Workload
	workloadErr              error
	markedExpired            []string
}

func (s *stubDB) Ping(_ context.Context) error { return nil }
func (s *stubDB) CurrentTime(_ context.Context) (time.Time, error) {
	if s.now.IsZero() {
		return time.Now(), nil
	}
	return s.now, nil
}
func (s *stubDB) GetApplicationByID(_ context.Context, _, _ string) (*Application, error) {
	return s.app, s.appErr
}
func (s *stubDB) GetApplicationByIDGlobal(_ context.Context, _ string) (*Application, error) {
	if s.appGlobal != nil || s.appGlobalErr != nil {
		return s.appGlobal, s.appGlobalErr
	}
	return s.app, s.appErr
}
func (s *stubDB) GetWorkloadByID(_ context.Context, _ string) (*Workload, error) {
	if s.workloadErr != nil {
		return nil, s.workloadErr
	}
	if s.workload == nil {
		return nil, errors.New("stub")
	}
	return s.workload, nil
}
func (s *stubDB) GetResourceByIdentifier(_ context.Context, _, _ string) (*Resource, error) {
	return s.resource, s.resErr
}
func (s *stubDB) GetProviderConnection(_ context.Context, _, _ string, providerID *string) (*ProviderConnection, error) {
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
func (s *stubDB) UpdateProviderConnectionTokens(_ context.Context, _ string, _ int, _, _ []byte, _ time.Time) error {
	return nil
}
func (s *stubDB) MarkProviderConnectionExpired(_ context.Context, id string) error {
	s.markedExpired = append(s.markedExpired, id)
	return nil
}
func (s *stubDB) GetProvider(_ context.Context, _ string) (*ProviderConfig, error) {
	if s.provider != nil {
		return s.provider, nil
	}
	return nil, errors.New("stub")
}
func (s *stubDB) GetSubjectIssuerByIssuer(_ context.Context, _, issuer string) (*SubjectIssuer, error) {
	if s.subjectIssuer != nil && s.subjectIssuer.Issuer == issuer {
		return s.subjectIssuer, nil
	}
	return nil, errors.New("stub: issuer not trusted")
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
func (s *stubDB) GetAuthorityRecord(_ context.Context, _ string) (*AuthorityRecord, error) {
	return s.session, s.sessionErr
}
func (s *stubDB) GetSession(_ context.Context, _ string) (*Session, error) {
	if s.agentErr != nil {
		return nil, s.agentErr
	}
	if s.agentIndex >= len(s.sessions) {
		return nil, errors.New("stub")
	}
	session := s.sessions[s.agentIndex]
	s.agentIndex++
	return session, nil
}
func (s *stubDB) GetDelegationLineage(_ context.Context, _, _ string, _ int) ([]string, error) {
	return s.path, s.pathErr
}
func (s *stubDB) GetDelegationGraphEpoch(_ context.Context, _ string) (int64, error) {
	return s.graphEpoch, s.epochErr
}
func (s *stubDB) InsertAuthorityRecord(_ context.Context, sess *AuthorityRecord) error {
	s.insertedAuthorityRecords = append(s.insertedAuthorityRecords, sess)
	return s.sessErr
}
func (s *stubDB) InsertAuthorityRecordWithApproval(_ context.Context, sess *AuthorityRecord, _ ConsumeApprovalParams) error {
	if s.sessErr != nil {
		return s.sessErr
	}
	s.insertedAuthorityRecords = append(s.insertedAuthorityRecords, sess)
	return nil
}
func (s *stubDB) InsertDelegatedAuthorityRecord(_ context.Context, sess *AuthorityRecord, _ DelegationIssuanceProof, _ *ConsumeApprovalParams) error {
	if s.sessErr != nil {
		return s.sessErr
	}
	s.insertedAuthorityRecords = append(s.insertedAuthorityRecords, sess)
	return nil
}
func (s *stubDB) RevokeAuthorityRecord(_ context.Context, _, _, _ string) error { return nil }
func (s *stubDB) GetStepUpChallenge(_ context.Context, _ string) (*StepUpChallengePG, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) GetOrCreateApprovalChallenge(_ context.Context, c *StepUpChallengePG) (*StepUpChallengePG, bool, error) {
	return c, true, nil
}
func (s *stubDB) DecideStepUpChallenge(_ context.Context, _ DecideStepUpParams) error { return nil }
func (s *stubDB) ConsumeApprovalChallenge(_ context.Context, _ ConsumeApprovalParams) error {
	return nil
}
func (s *stubDB) AuthorityRecordsRelated(_ context.Context, _, _, _ string) (bool, error) {
	return false, nil
}
func (s *stubDB) DeleteExpiredStepUpChallenges(_ context.Context, _ time.Time) (int64, error) {
	return 0, nil
}
func (s *stubDB) EnsureZoneSigningKeySecret(_ context.Context, _ string, _ []byte) (*SecretRow, error) {
	return nil, errors.New("stub")
}
func (s *stubDB) InsertZoneSigningKeySecret(_ context.Context, _ string, envelope []byte) (*SecretRow, error) {
	row := &SecretRow{ID: "kid-rotated", Envelope: envelope}
	s.insertedKey = row
	return row, nil
}
func (s *stubDB) GetZoneSigningKeySecret(_ context.Context, _ string) (*SecretRow, error) {
	if s.secretsErr != nil {
		return nil, s.secretsErr
	}
	if len(s.secrets) > 0 {
		return &s.secrets[0], nil
	}
	return nil, errors.New("stub")
}
func (s *stubDB) GetZoneSigningKeySecrets(_ context.Context, _ string) ([]SecretRow, error) {
	if s.secretsErr != nil {
		return nil, s.secretsErr
	}
	if len(s.secrets) > 0 {
		return s.secrets, nil
	}
	return nil, errors.New("stub")
}
func (s *stubDB) GetSecretStoreEnvelope(_ context.Context, ref string) ([]byte, error) {
	if envelope, ok := s.storeEnvelopes[ref]; ok {
		return envelope, nil
	}
	return nil, pgx.ErrNoRows
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

func TestValidateTokenAuthorityRecordBindsClientID(t *testing.T) {
	now := time.Now()
	subjectID := "user-1"
	srv := &Server{db: &stubDB{session: &AuthorityRecord{
		ID:        "sess-1",
		ZoneID:    "zone1",
		Status:    "active",
		SubjectID: &subjectID,
		ExpiresAt: now.Add(time.Minute),
	}, now: now}}
	claims := map[string]any{
		"sid":       "sess-1",
		"sub":       subjectID,
		"client_id": "app1",
	}
	if sid, err := srv.validateAuthorityRecord(context.Background(), "zone1", "app1", "", claims); err != nil || sid != "sess-1" {
		t.Fatalf("matching client_id must pass, sid=%q err=%#v", sid, err)
	}
	if _, err := srv.validateAuthorityRecord(context.Background(), "zone1", "app2", "", claims); err == nil || err.Description != "authority record client mismatch" {
		t.Fatalf("wrong client_id must fail, got %#v", err)
	}
}

func TestValidateTokenAuthorityRecordUsesDatabaseTime(t *testing.T) {
	now := time.Now()
	subjectID := "user-1"
	srv := &Server{db: &stubDB{session: &AuthorityRecord{
		ID:        "sess-1",
		ZoneID:    "zone1",
		Status:    "active",
		SubjectID: &subjectID,
		ExpiresAt: now.Add(time.Minute),
	}, now: now.Add(2 * time.Minute)}}
	claims := map[string]any{
		"sid":       "sess-1",
		"sub":       subjectID,
		"client_id": "app1",
	}
	if _, err := srv.validateAuthorityRecord(context.Background(), "zone1", "app1", "", claims); err == nil || err.Description != "authority record inactive or expired" {
		t.Fatalf("database-expired session must fail, got %#v", err)
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

func TestAuthenticateAppRejectsApplicationIdentityWithoutSecret(t *testing.T) {
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	srv := &Server{db: &stubDB{app: &Application{
		ID:                 "app1",
		ZoneID:             "zone1",
		Name:               "Test App",
		RegistrationMethod: "managed",
		ClientSecretHash:   &hash,
	}}}
	if _, _, err := srv.authenticateApp(context.Background(), TokenExchangeRequest{
		ZoneID:        "zone1",
		ApplicationID: "app1",
	}); !errors.Is(err, errSecretMismatch) {
		t.Fatalf("application identity without secret must fail, got %v", err)
	}
}

func TestAuthenticateAppDerivesZoneForControlKey(t *testing.T) {
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	srv := &Server{db: &stubDB{app: &Application{
		ID:                 "control-app",
		ZoneID:             "zone-bound",
		Name:               "Control key",
		RegistrationMethod: "managed",
		ClientSecretHash:   &hash,
		Traits:             []string{controlInvokeTrait, controlScopeTrait + "control:resource:read"},
	}}}
	app, zoneID, err := srv.authenticateApp(context.Background(), TokenExchangeRequest{
		ApplicationID: "control-app",
		ClientSecret:  "test-secret",
		Resources:     []string{defaultControlAudience},
		Scope:         "control:resource:read",
	})
	if err != nil || app.ID != "control-app" || zoneID != "zone-bound" {
		t.Fatalf("control key should derive zone, app=%#v zone=%q err=%v", app, zoneID, err)
	}
}

func TestAuthenticateAppRejectsZoneLessControlKeyForNonControlResource(t *testing.T) {
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	srv := &Server{db: &stubDB{app: &Application{
		ID:                 "control-app",
		ZoneID:             "zone-bound",
		Name:               "Control key",
		RegistrationMethod: "managed",
		ClientSecretHash:   &hash,
		Traits:             []string{controlInvokeTrait, controlScopeTrait + "control:resource:read"},
	}}}
	if _, _, err := srv.authenticateApp(context.Background(), TokenExchangeRequest{
		ApplicationID: "control-app",
		ClientSecret:  "test-secret",
		Resources:     []string{"resource://payments"},
		Scope:         "control:resource:read",
	}); err == nil || !strings.Contains(err.Error(), "zone_id required") {
		t.Fatalf("zone-less control key must be limited to Control audience, got %v", err)
	}
}

func TestAuthenticateAppRejectsZoneLessNonControlApplication(t *testing.T) {
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	srv := &Server{db: &stubDB{app: &Application{
		ID:                 "app1",
		ZoneID:             "zone1",
		Name:               "Test App",
		RegistrationMethod: "managed",
		ClientSecretHash:   &hash,
	}}}
	if _, _, err := srv.authenticateApp(context.Background(), TokenExchangeRequest{
		ApplicationID: "app1",
		ClientSecret:  "test-secret",
	}); err == nil || !strings.Contains(err.Error(), "zone_id required") {
		t.Fatalf("non-control application without zone_id must fail, got %v", err)
	}
}

func TestAuthenticateAppReportsCrossZoneCredentialWhenSecretVerifies(t *testing.T) {
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	srv := &Server{db: &stubDB{
		appErr: errors.New("not found in requested zone"),
		appGlobal: &Application{
			ID:                 "app1",
			ZoneID:             "zone-actual",
			Name:               "Test App",
			RegistrationMethod: "managed",
			ClientSecretHash:   &hash,
		},
	}}
	_, _, err = srv.authenticateApp(context.Background(), TokenExchangeRequest{
		ZoneID:        "zone-requested",
		ApplicationID: "app1",
		ClientSecret:  "test-secret",
	})
	var zoneErr *zoneMismatchError
	if !errors.As(err, &zoneErr) {
		t.Fatalf("cross-zone credential with valid secret must report a zone mismatch, got %v", err)
	}
	if zoneErr.actual != "zone-actual" || zoneErr.requested != "zone-requested" {
		t.Fatalf("zone mismatch must carry both zones, got %#v", zoneErr)
	}
}

func TestAuthenticateAppHidesCrossZoneExistenceWhenSecretWrong(t *testing.T) {
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	srv := &Server{db: &stubDB{
		appErr: errors.New("not found in requested zone"),
		appGlobal: &Application{
			ID:                 "app1",
			ZoneID:             "zone-actual",
			Name:               "Test App",
			RegistrationMethod: "managed",
			ClientSecretHash:   &hash,
		},
	}}
	_, _, err = srv.authenticateApp(context.Background(), TokenExchangeRequest{
		ZoneID:        "zone-requested",
		ApplicationID: "app1",
		ClientSecret:  "wrong-secret",
	})
	var zoneErr *zoneMismatchError
	if errors.As(err, &zoneErr) {
		t.Fatalf("a wrong secret must not disclose cross-zone existence, got %v", err)
	}
	if err == nil {
		t.Fatalf("cross-zone lookup with a wrong secret must still fail")
	}
}

func TestExchangeMapsZoneMismatchToZoneInvalid(t *testing.T) {
	hash, err := hashClientSecret("test-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	srv := &Server{db: &stubDB{
		appErr: errors.New("not found in requested zone"),
		appGlobal: &Application{
			ID:                 "app1",
			ZoneID:             "zone-actual",
			Name:               "Test App",
			RegistrationMethod: "managed",
			ClientSecretHash:   &hash,
		},
	}}
	_, _, status, exErr := srv.exchange(context.Background(), TokenExchangeRequest{
		ZoneID:        "zone-requested",
		ApplicationID: "app1",
		ClientSecret:  "test-secret",
		Resources:     []string{"resource://payments"},
	}, "req-1")
	if status != http.StatusForbidden {
		t.Fatalf("zone mismatch must map to 403, got %d", status)
	}
	if exErr == nil || exErr.Code != sharederr.ZoneInvalid {
		t.Fatalf("zone mismatch must surface zone_invalid, got %#v", exErr)
	}
	if !strings.Contains(exErr.Description, "zone-actual") || !strings.Contains(exErr.Description, "zone-requested") {
		t.Fatalf("zone_invalid message must name both zones, got %q", exErr.Description)
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
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, false, false)
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
	token := sealConnectionToken(t, zek, "provider-access-token")
	expiresAt := time.Now().Add(time.Minute)
	srv := &Server{
		db: &stubDB{
			grant:    &ProviderConnection{ProviderID: &providerID, AccessTokenCt: token, ExpiresAt: &expiresAt},
			provider: &ProviderConfig{ID: providerID, ProviderKind: strPtr("oauth2_authorization_code")},
		},
		keys: &KeyCache{keyring: testKeyring(zek)},
	}
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
	if err != nil {
		t.Fatalf("gateway directive should decrypt provider token: %v", err)
	}
	if directive.ProviderToken != "provider-access-token" || directive.AuthMode != UpstreamAuthProviderOAuth || directive.AuthScheme != "Bearer" {
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
	token := sealConnectionToken(t, zek, "provider-access-token")
	srv := &Server{
		db:   &stubDB{grant: &ProviderConnection{ProviderID: &otherProviderID, AccessTokenCt: token}},
		keys: &KeyCache{keyring: testKeyring(zek)},
	}
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false); err == nil {
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
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{"header_name":"X-Api-Key"}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
	}, zek)
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
	if err != nil {
		t.Fatalf("gateway directive should support API key provider shape: %v", err)
	}
	if directive.AuthMode != UpstreamAuthProviderAPIKey || directive.AuthLocation != "header" || directive.AuthHeader != "X-Api-Key" || directive.AuthScheme != "" || directive.ProviderToken != "api-key-value" {
		t.Fatalf("unexpected apikey directive: %#v", directive)
	}
}

func TestBuildUpstreamDirectiveSupportsAPIKeyAuthorizationScheme(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{"header_name":"Authorization","auth_scheme":"Bearer"}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
	}, zek)
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
	if err != nil {
		t.Fatalf("gateway directive should support API key auth scheme: %v", err)
	}
	if directive.AuthMode != UpstreamAuthProviderAPIKey || directive.AuthLocation != "header" || directive.AuthHeader != "Authorization" || directive.AuthScheme != "Bearer" || directive.ProviderToken != "api-key-value" {
		t.Fatalf("unexpected apikey directive: %#v", directive)
	}
}

func TestBuildUpstreamDirectiveSupportsAPIKeyQueryParameter(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{"auth_location":"query","query_param_name":"api_key"}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
	}, zek)
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
	if err != nil {
		t.Fatalf("gateway directive should support API key query parameter: %v", err)
	}
	if directive.AuthMode != UpstreamAuthProviderAPIKey || directive.AuthLocation != "query" || directive.QueryParamName != "api_key" || directive.AuthHeader != "" || directive.AuthScheme != "" || directive.ProviderToken != "api-key-value" {
		t.Fatalf("unexpected apikey query directive: %#v", directive)
	}
}

func TestBuildUpstreamDirectiveSupportsBearerTokenProviderShape(t *testing.T) {
	cases := []struct {
		name       string
		configJSON string
		wantHeader string
		wantScheme string
	}{
		{
			name:       "default authorization bearer",
			configJSON: `{}`,
			wantHeader: "Authorization",
			wantScheme: "Bearer",
		},
		{
			name:       "custom header and scheme",
			configJSON: `{"auth_header":"X-Provider-Authorization","auth_scheme":"Token","allowed_token_hosts":["API.Hooli.Example"]}`,
			wantHeader: "X-Provider-Authorization",
			wantScheme: "Token",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			providerID := "provider1"
			upstreamURL := "https://upstream.example"
			resource := &Resource{
				ID:                   "res1",
				Identifier:           "resource://api",
				UpstreamURL:          &upstreamURL,
				CredentialProviderID: &providerID,
			}
			zek := []byte("12345678901234567890123456789012")
			srv := providerServer(&stubDB{
				provider: &ProviderConfig{
					ID:           providerID,
					ProviderKind: strPtr("bearer_token"),
					ConfigJSON:   []byte(tc.configJSON),
				},
				storeEnvelopes: testProviderSecret(t, zek, providerID, `{"bearer_token":"provider-bearer-token"}`),
			}, zek)
			directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
			if err != nil {
				t.Fatalf("gateway directive should support bearer token provider shape: %v", err)
			}
			if directive.AuthMode != UpstreamAuthProviderOAuth || directive.AuthHeader != tc.wantHeader || directive.AuthScheme != tc.wantScheme || directive.ProviderToken != "provider-bearer-token" {
				t.Fatalf("unexpected bearer token directive: %#v", directive)
			}
			if tc.name == "custom header and scheme" && (len(directive.AllowedTokenHosts) != 1 || directive.AllowedTokenHosts[0] != "api.hooli.example") {
				t.Fatalf("unexpected bearer token hosts: %#v", directive.AllowedTokenHosts)
			}
		})
	}
}

func TestBuildUpstreamDirectiveCarriesHostGuardrailForStaticKinds(t *testing.T) {
	cases := []struct {
		name       string
		kind       string
		configJSON string
		secretJSON string
	}{
		{
			name:       "api key header",
			kind:       "api_key",
			configJSON: `{"header_name":"X-API-Key","allowed_token_hosts":["API.Hooli.Example"]}`,
			secretJSON: `{"api_key":"api-key-value"}`,
		},
		{
			name:       "http basic",
			kind:       "http_basic",
			configJSON: `{"username":"svc-hooli","allowed_token_hosts":["API.Hooli.Example"]}`,
			secretJSON: `{"password":"basic-password"}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			providerID := "provider1"
			upstreamURL := "https://upstream.example"
			resource := &Resource{
				ID:                   "res1",
				Identifier:           "resource://api",
				UpstreamURL:          &upstreamURL,
				CredentialProviderID: &providerID,
			}
			zek := []byte("12345678901234567890123456789012")
			srv := providerServer(&stubDB{
				provider: &ProviderConfig{
					ID:           providerID,
					ProviderKind: strPtr(tc.kind),
					ConfigJSON:   []byte(tc.configJSON),
				},
				storeEnvelopes: testProviderSecret(t, zek, providerID, tc.secretJSON),
			}, zek)
			directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
			if err != nil {
				t.Fatalf("gateway directive should carry the host guardrail: %v", err)
			}
			if len(directive.AllowedTokenHosts) != 1 || directive.AllowedTokenHosts[0] != "api.hooli.example" {
				t.Fatalf("unexpected %s hosts: %#v", tc.kind, directive.AllowedTokenHosts)
			}
		})
	}
}

func TestBuildUpstreamDirectiveSupportsCaracalMandateProviderShape(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	srv := &Server{
		db: &stubDB{
			provider: &ProviderConfig{
				ID:           providerID,
				ProviderKind: strPtr("caracal_mandate"),
				ConfigJSON:   []byte(`{}`),
			},
		},
	}
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
	if err != nil {
		t.Fatalf("gateway directive should support Caracal mandate provider shape: %v", err)
	}
	if directive.AuthMode != UpstreamAuthCaracalJWT || directive.AuthHeader != "Authorization" || directive.AuthScheme != "Bearer" || directive.ProviderToken != "" {
		t.Fatalf("unexpected Caracal mandate directive: %#v", directive)
	}
}

func TestBuildUpstreamDirectiveSupportsNoneProviderShape(t *testing.T) {
	providerID := "provider-none"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	srv := &Server{
		db: &stubDB{
			provider: &ProviderConfig{
				ID:           providerID,
				ProviderKind: strPtr("none"),
				ConfigJSON:   []byte(`{}`),
			},
		},
	}
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
	if err != nil {
		t.Fatalf("gateway directive should support none provider shape: %v", err)
	}
	if directive.AuthMode != UpstreamAuthNone || directive.AuthHeader != "" || directive.AuthScheme != "" || directive.ProviderToken != "" {
		t.Fatalf("unexpected none directive: %#v", directive)
	}
	if directive.ProviderID != providerID {
		t.Fatalf("provider id missing from none directive: %#v", directive)
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
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{"header_name":"X-Api-Key","forward_caracal_identity":true}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
	}, zek)
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
	if err != nil {
		t.Fatalf("gateway directive should support identity forwarding opt-in: %v", err)
	}
	if !directive.ForwardCaracalIdentity {
		t.Fatalf("identity forwarding opt-in not propagated: %#v", directive)
	}
}

func TestBuildUpstreamDirectiveRequiresRuntimeInjectionOptIn(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{"header_name":"X-Api-Key"}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
	}, zek)
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, true); err == nil {
		t.Fatal("runtime provider injection must require provider opt-in")
	}
}

func TestBuildUpstreamDirectiveAllowsRuntimeProviderInjection(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{"header_name":"X-Api-Key","allow_runtime_injection":true}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
	}, zek)
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, true)
	if err != nil {
		t.Fatalf("runtime provider injection should decrypt opted-in provider token: %v", err)
	}
	if directive.ProviderToken != "api-key-value" || directive.AuthMode != UpstreamAuthProviderAPIKey {
		t.Fatalf("runtime provider injection should return provider credential, got %#v", directive)
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
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
	}, zek)
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false); err == nil {
		t.Fatal("apikey provider directive must require an explicit auth header")
	}
}

func TestBuildUpstreamDirectiveRejectsLegacyAPIKeyAuthHeader(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{"auth_header":"X-Api-Key"}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
	}, zek)
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false); err == nil {
		t.Fatal("apikey provider directive must use header_name, not auth_header")
	}
}

func TestBuildUpstreamDirectiveRejectsInvalidAPIKeyQueryConfig(t *testing.T) {
	cases := []struct {
		name       string
		configJSON string
	}{
		{
			name:       "missing query parameter",
			configJSON: `{"auth_location":"query"}`,
		},
		{
			name:       "malformed query parameter",
			configJSON: `{"auth_location":"query","query_param_name":"api key"}`,
		},
		{
			name:       "query parameter with auth scheme",
			configJSON: `{"auth_location":"query","query_param_name":"api_key","auth_scheme":"Bearer"}`,
		},
		{
			name:       "unsupported location",
			configJSON: `{"auth_location":"cookie","query_param_name":"api_key"}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			providerID := "provider1"
			upstreamURL := "https://upstream.example"
			resource := &Resource{
				ID:                   "res1",
				Identifier:           "resource://api",
				UpstreamURL:          &upstreamURL,
				CredentialProviderID: &providerID,
			}
			zek := []byte("12345678901234567890123456789012")
			srv := providerServer(&stubDB{
				provider: &ProviderConfig{
					ID:           providerID,
					ProviderKind: strPtr("api_key"),
					ConfigJSON:   []byte(tc.configJSON),
				},
				storeEnvelopes: testProviderSecret(t, zek, providerID, `{"api_key":"api-key-value"}`),
			}, zek)
			if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false); err == nil {
				t.Fatal("apikey provider directive must reject invalid query config")
			}
		})
	}
}

func TestBuildUpstreamDirectiveRejectsBearerTokenWithoutSecret(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("bearer_token"),
			ConfigJSON:   []byte(`{}`),
		},
	}, []byte("12345678901234567890123456789012"))
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false); err == nil {
		t.Fatal("bearer token provider directive must require a sealed bearer token")
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
	token := sealConnectionToken(t, zek, "provider-access-token")
	srv := &Server{
		db: &stubDB{
			grant: &ProviderConnection{ProviderID: &providerID, AccessTokenCt: token},
			provider: &ProviderConfig{
				ID:           providerID,
				ProviderKind: strPtr("oauth2_authorization_code"),
				ConfigJSON:   []byte(`{bad json`),
			},
		},
		keys: &KeyCache{keyring: testKeyring(zek)},
	}
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false); err == nil {
		t.Fatal("provider directive must reject malformed provider config")
	}
}

func TestBuildUpstreamDirectiveRejectsMalformedProviderAuthScheme(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	token := sealConnectionToken(t, zek, "provider-access-token")
	srv := &Server{
		db: &stubDB{
			grant: &ProviderConnection{ProviderID: &providerID, AccessTokenCt: token},
			provider: &ProviderConfig{
				ID:           providerID,
				ProviderKind: strPtr("oauth2_authorization_code"),
				ConfigJSON:   []byte(`{"auth_scheme":"Bearer Token"}`),
			},
		},
		keys: &KeyCache{keyring: testKeyring(zek)},
	}
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false); err == nil {
		t.Fatal("provider directive must reject malformed auth schemes")
	}
}

func TestOAuthClientCredentialsFormIncludesProviderTokenParameters(t *testing.T) {
	form, err := oauthClientCredentialsForm(oauthClientCredentialsConfig{
		Scopes:      []string{"read", "write"},
		Audience:    " https://api.example.com ",
		Resource:    " https://resource.example.com ",
		TokenParams: map[string]string{"tenant": "hooli"},
	})
	if err != nil {
		t.Fatalf("build form: %v", err)
	}
	if form.Get("grant_type") != "client_credentials" {
		t.Fatalf("unexpected grant_type: %s", form.Get("grant_type"))
	}
	if form.Get("scope") != "read write" {
		t.Fatalf("unexpected scope: %s", form.Get("scope"))
	}
	if form.Get("audience") != "https://api.example.com" {
		t.Fatalf("unexpected audience: %s", form.Get("audience"))
	}
	if form.Get("resource") != "https://resource.example.com" {
		t.Fatalf("unexpected resource: %s", form.Get("resource"))
	}
	if form.Get("tenant") != "hooli" {
		t.Fatalf("unexpected token param: %s", form.Get("tenant"))
	}
}

func TestBuildProviderTokenRequestImplementsClientAuthMethods(t *testing.T) {
	endpoint, err := url.Parse("https://issuer.example.com/oauth/token")
	if err != nil {
		t.Fatal(err)
	}
	basicReq, err := buildProviderTokenRequest(context.Background(), endpoint, url.Values{"grant_type": {"client_credentials"}}, "client-id", "client-secret", "client_secret_basic", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("client-id:client-secret"))
	if basicReq.Header.Get("Authorization") != wantAuth {
		t.Fatalf("basic auth header mismatch: %s", basicReq.Header.Get("Authorization"))
	}
	body, err := io.ReadAll(basicReq.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "client_secret") {
		t.Fatalf("client_secret_basic must not put client_secret in the form body: %s", string(body))
	}

	postReq, err := buildProviderTokenRequest(context.Background(), endpoint, url.Values{"grant_type": {"client_credentials"}}, "client-id", "client-secret", "client_secret_post", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if postReq.Header.Get("Authorization") != "" {
		t.Fatalf("client_secret_post must not set Authorization: %s", postReq.Header.Get("Authorization"))
	}
	body, err = io.ReadAll(postReq.Body)
	if err != nil {
		t.Fatal(err)
	}
	values, err := url.ParseQuery(string(body))
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("client_id") != "client-id" || values.Get("client_secret") != "client-secret" {
		t.Fatalf("client_secret_post body mismatch: %s", string(body))
	}

	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate client assertion key: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatalf("marshal client assertion key: %v", err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	jwtReq, err := buildProviderTokenRequest(context.Background(), endpoint, url.Values{"grant_type": {"client_credentials"}}, "client-id", "", "private_key_jwt", "key-1", string(pemKey), "")
	if err != nil {
		t.Fatal(err)
	}
	if jwtReq.Header.Get("Authorization") != "" {
		t.Fatalf("private_key_jwt must not set Authorization: %s", jwtReq.Header.Get("Authorization"))
	}
	body, err = io.ReadAll(jwtReq.Body)
	if err != nil {
		t.Fatal(err)
	}
	values, err = url.ParseQuery(string(body))
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("client_id") != "client-id" || values.Get("client_secret") != "" {
		t.Fatalf("private_key_jwt body credential mismatch: %s", string(body))
	}
	if values.Get("client_assertion_type") != "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" {
		t.Fatalf("private_key_jwt assertion type mismatch: %s", string(body))
	}
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(values.Get("client_assertion"), claims, func(token *jwt.Token) (any, error) {
		if token.Method.Alg() != jwt.SigningMethodES256.Alg() {
			t.Fatalf("unexpected client assertion alg: %s", token.Method.Alg())
		}
		if token.Header["kid"] != "key-1" {
			t.Fatalf("unexpected client assertion kid: %#v", token.Header["kid"])
		}
		return &privateKey.PublicKey, nil
	})
	if err != nil || !token.Valid {
		t.Fatalf("client assertion invalid: token=%#v err=%v", token, err)
	}
	if claims["iss"] != "client-id" || claims["sub"] != "client-id" || claims["aud"] != endpoint.String() || claims["jti"] == "" {
		t.Fatalf("client assertion claims mismatch: %#v", claims)
	}

	noneReq, err := buildProviderTokenRequest(context.Background(), endpoint, url.Values{"grant_type": {"client_credentials"}}, "client-id", "", "none", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if noneReq.Header.Get("Authorization") != "" {
		t.Fatalf("none auth must not set Authorization: %s", noneReq.Header.Get("Authorization"))
	}
	body, err = io.ReadAll(noneReq.Body)
	if err != nil {
		t.Fatal(err)
	}
	values, err = url.ParseQuery(string(body))
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("client_id") != "client-id" || values.Get("client_secret") != "" {
		t.Fatalf("none auth body mismatch: %s", string(body))
	}
}

func TestProviderServiceTokenCacheRequiresFreshMatchingFingerprint(t *testing.T) {
	srv := &Server{}
	now := time.Now()
	srv.storeProviderServiceToken("provider1", "fp1", "token1", now.Add(5*time.Minute))
	if token, ok := srv.cachedProviderServiceToken("provider1", "fp1", now); !ok || token != "token1" {
		t.Fatalf("expected cached token, got %q ok=%v", token, ok)
	}
	if _, ok := srv.cachedProviderServiceToken("provider1", "fp2", now); ok {
		t.Fatal("cache must miss when provider fingerprint changes")
	}
	srv.storeProviderServiceToken("provider2", "fp1", "token2", now.Add(providerTokenCacheSkew/2))
	if _, ok := srv.cachedProviderServiceToken("provider2", "fp1", now); ok {
		t.Fatal("cache must miss when token is inside refresh skew")
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

func TestValidateAuthorityRecordReferencesRequiresSessionForDelegation(t *testing.T) {
	srv := &Server{db: &stubDB{}}
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		DelegationEdgeID: "edge1",
	}, true)
	if err == nil || err.Description != "delegation requires a target Session" {
		t.Fatalf("want target Session error, got %#v", err)
	}
}

func TestValidateAuthorityRecordReferencesRejectsAgentSubjectBindingMismatch(t *testing.T) {
	now := time.Now()
	db := &stubDB{
		now: now,
		session: &AuthorityRecord{
			ID:        "subject-session-2",
			ZoneID:    "zone1",
			Status:    "active",
			ExpiresAt: now.Add(time.Minute),
		},
		sessions: []*Session{{
			ID:                       "agent-1",
			ZoneID:                   "zone1",
			ApplicationID:            "app1",
			SubjectAuthorityRecordID: "subject-session-1",
			Status:                   "active",
			StartedAt:                now.Add(-time.Minute),
			TTLSeconds:               600,
		}},
	}
	srv := &Server{db: db}
	_, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AuthorityRecordID: "subject-session-2",
		SessionID:         "agent-1",
	}, true)
	if err == nil || err.Description != "session authority record binding mismatch" {
		t.Fatalf("want subject binding mismatch, got %#v", err)
	}
}

func TestValidateAuthorityRecordReferencesAcceptsGatewayChildAuthorityRecord(t *testing.T) {
	now := time.Now()
	parentID := "subject-session-1"
	subjectID := "app1"
	db := &stubDB{
		now: now,
		session: &AuthorityRecord{
			ID:          "gateway-session-1",
			ZoneID:      "zone1",
			SessionType: "application",
			SubjectID:   &subjectID,
			ParentID:    &parentID,
			Status:      "active",
			ExpiresAt:   now.Add(time.Minute),
		},
		sessions: []*Session{{
			ID:                       "agent-1",
			ZoneID:                   "zone1",
			ApplicationID:            "app1",
			SubjectAuthorityRecordID: parentID,
			Status:                   "active",
			StartedAt:                now.Add(-time.Minute),
			TTLSeconds:               600,
		}},
	}
	srv := &Server{db: db}
	_, session, err := srv.validateSessionReferences(context.Background(), "zone1", "app1", TokenExchangeRequest{
		AuthorityRecordID: "gateway-session-1",
		SessionID:         "agent-1",
	}, true)
	if err != nil || session == nil || session.ID != "agent-1" {
		t.Fatalf("want Gateway child authority record accepted, session=%#v err=%#v", session, err)
	}
}

func TestValidateAuthorityRecordReferencesAcceptsActiveGraphEdge(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:                       "agent-dst",
		ZoneID:                   "zone1",
		ApplicationID:            "app2",
		SubjectAuthorityRecordID: "subject-session-1",
		Status:                   "active",
		StartedAt:                now.Add(-time.Minute),
		TTLSeconds:               600,
	}
	db := &stubDB{
		sessions:   []*Session{source, target},
		path:       []string{"edge1"},
		graphEpoch: 7,
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
	proof, session, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		SessionID:        target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err != nil || proof == nil || proof.edge.ID != "edge1" || proof.graphEpoch != 7 {
		t.Fatalf("want active delegation proof, got proof=%#v err=%#v", proof, err)
	}
	if session == nil || session.ID != target.ID {
		t.Fatalf("target Session not returned for policy input: %#v", session)
	}
}

func TestSessionMetadataIsPolicyAndAuditInput(t *testing.T) {
	session := &Session{
		ID:        "agent-1",
		Lifecycle: "task",
		Labels:    []string{"browser", "code"},
	}
	if got := sessionLifecycle(session); got != "task" {
		t.Fatalf("lifecycle = %q", got)
	}
	caps := sessionLabels(session)
	caps[0] = "mutated"
	if session.Labels[0] != "browser" {
		t.Fatal("labels must be copied before policy evaluation")
	}
	meta := agentAuditMeta(session)
	if meta["agent_lifecycle"] != "task" {
		t.Fatalf("audit metadata missing lifecycle: %#v", meta)
	}
	gotCaps, ok := meta["agent_labels"].([]string)
	if !ok || len(gotCaps) != 2 || gotCaps[1] != "code" {
		t.Fatalf("audit metadata missing labels: %#v", meta)
	}
}

func TestApplicationMetadataIsPolicyAndAuditInput(t *testing.T) {
	input := OPAInput{
		Principal: OPAPrincipal{
			Type:               "Application",
			ID:                 "app-dcr",
			ZoneID:             "zone-1",
			RegistrationMethod: "dcr",
		},
	}
	if input.Principal.RegistrationMethod != "dcr" {
		t.Fatalf("registration method missing from policy input: %#v", input.Principal)
	}
	meta := applicationAuditMeta(&Application{ID: "app-dcr", Name: "Fiona", RegistrationMethod: "dcr"})
	if meta["application_registration_method"] != "dcr" || meta["application_id"] != "app-dcr" {
		t.Fatalf("application audit metadata missing identity: %#v", meta)
	}
	merged := mergeAuditMeta(meta, map[string]any{"resource": "api"})
	if _, exists := meta["resource"]; exists {
		t.Fatalf("mergeAuditMeta mutated original metadata: %#v", meta)
	}
	if merged["application_name"] != "Fiona" || merged["resource"] != "api" {
		t.Fatalf("merged metadata incomplete: %#v", merged)
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

func TestBindGovernedSessionCopiesSignedClaim(t *testing.T) {
	req := TokenExchangeRequest{}
	err := bindGovernedSession(&req, map[string]any{"agent_session_id": "agent-1"})
	if err != nil {
		t.Fatalf("bind signed Session: %v", err)
	}
	if req.SessionID != "agent-1" {
		t.Fatalf("Session id = %q, want agent-1", req.SessionID)
	}
}

func TestBindGovernedSessionRejectsMismatch(t *testing.T) {
	req := TokenExchangeRequest{SessionID: "agent-2"}
	err := bindGovernedSession(&req, map[string]any{"agent_session_id": "agent-1"})
	if err == nil || err.Description != "Session mismatch" {
		t.Fatalf("want mismatch error, got %#v", err)
	}
}

func TestBindDelegationEdgeCopiesSignedClaim(t *testing.T) {
	req := TokenExchangeRequest{}
	if err := bindDelegationEdge(&req, map[string]any{"delegation_edge_id": "edge-1"}); err != nil {
		t.Fatal(err)
	}
	if req.DelegationEdgeID != "edge-1" {
		t.Fatalf("signed delegation claim was not copied: %#v", req)
	}
}

func TestBindDelegationEdgeRejectsMismatch(t *testing.T) {
	req := TokenExchangeRequest{DelegationEdgeID: "edge-explicit"}
	err := bindDelegationEdge(&req, map[string]any{"delegation_edge_id": "edge-signed"})
	if err == nil || err.Description != "delegation mismatch" {
		t.Fatalf("expected delegation mismatch, got %#v", err)
	}
}

func TestBindDelegationEdgeRejectsExplicitRequestWithoutSignedClaim(t *testing.T) {
	req := TokenExchangeRequest{DelegationEdgeID: "edge-explicit"}
	err := bindDelegationEdge(&req, map[string]any{})
	if err == nil || err.Description != "delegation claim missing from subject token" {
		t.Fatalf("expected missing claim denial, got %#v", err)
	}
}

func TestDistinctScopesCanonicalizesDuplicates(t *testing.T) {
	got := distinctScopes("write read write read")
	if !slices.Equal(got, []string{"read", "write"}) {
		t.Fatalf("unexpected distinct scopes: %v", got)
	}
}

func TestValidateAuthorityRecordReferencesRejectsSourceUsingDelegationEdge(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		sessions: []*Session{source, target},
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
		SessionID:        source.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err == nil || err.Description != "delegation target mismatch" {
		t.Fatalf("source Session must not consume target Delegation, got %#v", err)
	}
}

func TestValidateAuthorityRecordReferencesRejectsUnrelatedAppUsingDelegationEdge(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		sessions: []*Session{source, target},
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
		SessionID:        target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err == nil || err.Description != "delegation target inactive or unauthorized" {
		t.Fatalf("unrelated app must not consume target Delegation, got %#v", err)
	}
}

func TestValidateAuthorityRecordReferencesRejectsExpiredDelegationEdge(t *testing.T) {
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
		SessionID:        "agent-dst",
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err == nil || err.Description != "delegation inactive or expired" {
		t.Fatalf("expired edge must fail, got %#v", err)
	}
}

func TestValidateAuthorityRecordReferencesRejectsScopeOutsideDelegationEdge(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		sessions: []*Session{source, target},
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
		SessionID:        target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "write",
	}, true)
	if err == nil || err.Description != "requested scopes exceed delegation scopes" {
		t.Fatalf("scope outside delegation must fail, got %#v", err)
	}
}

func TestParseDelegationConstraintsRejectsRetiredBudget(t *testing.T) {
	if _, err := parseDelegationConstraints([]byte(`{"budget":1,"max_hops":1}`)); err == nil {
		t.Fatal("retired budget constraint must be rejected")
	}
}

func TestValidateAuthorityRecordReferencesRejectsDelegationTTLConstraint(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		sessions: []*Session{source, target},
		path:     []string{"edge1"},
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
		SessionID:        target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
		TTLSeconds:       60,
	}, true)
	if err == nil || err.Description != "requested ttl exceeds delegation ttl" {
		t.Fatalf("want ttl constraint error, got %#v", err)
	}

	db.agentIndex = 0
	proof, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		SessionID:        target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err != nil || proof == nil || proof.constraints.TTLSeconds != 30 {
		t.Fatalf("default ttl should be capped at issuance instead of rejected, proof=%#v err=%#v", proof, err)
	}
}

func TestValidateAuthorityRecordReferencesRejectsMalformedDelegationConstraints(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		sessions: []*Session{source, target},
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
		SessionID:        target.ID,
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
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
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
		sessions:   []*Session{source, target},
		path:       []string{"edge1"},
		graphEpoch: 9,
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
		SessionID:        target.ID,
		DelegationEdgeID: "edge1",
	}, "req-1")
	if code != http.StatusForbidden || apiErr == nil || apiErr.Description != "policy denied" {
		t.Fatalf("want soft-deny with no granted resources, code=%d err=%#v", code, apiErr)
	}
}

func TestValidateAuthorityRecordReferencesRejectsInvalidDelegationPath(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		sessions: []*Session{source, target},
		path:     []string{"other-edge"},
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
		SessionID:        target.ID,
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

func TestValidateAuthorityRecordReferencesRejectsMaxHopOverflow(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	db := &stubDB{
		sessions: []*Session{source, target},
		path:     []string{"edge0", "edge1"},
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
		SessionID:        target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err == nil || err.Description != "delegation hop allowance exhausted" {
		t.Fatalf("want max-hop path error, got %#v", err)
	}
}

func TestValidateAuthorityRecordReferencesAcceptsDeepDelegationPath(t *testing.T) {
	now := time.Now()
	source := &Session{
		ID:            "agent-src",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	target := &Session{
		ID:            "agent-dst",
		ZoneID:        "zone1",
		ApplicationID: "app2",
		Status:        "active",
		StartedAt:     now.Add(-time.Minute),
		TTLSeconds:    600,
	}
	parentEdgeID := "edge0"
	mainEdge := &DelegationEdge{
		ID:              "edge1",
		ZoneID:          "zone1",
		SourceSessionID: source.ID,
		TargetSessionID: target.ID,
		IssuerAppID:     source.ApplicationID,
		ReceiverAppID:   target.ApplicationID,
		ParentEdgeID:    &parentEdgeID,
		Scopes:          []string{"read"},
		Status:          "active",
		ExpiresAt:       now.Add(time.Minute),
		ConstraintsJSON: []byte(`{"max_hops":2}`),
	}
	// Build a valid 2-edge parent lineage: app1→app1 (edge0), app1→app2 (edge1).
	// Continuity: each edge's IssuerAppID must equal the previous edge's ReceiverAppID.
	db := &stubDB{
		sessions:   []*Session{source, target},
		path:       []string{"edge0", "edge1"},
		graphEpoch: 12,
		edge:       mainEdge,
		edgesMap: map[string]*DelegationEdge{
			"edge0": {
				ID:              "edge0",
				ZoneID:          "zone1",
				SourceSessionID: source.ID,
				TargetSessionID: source.ID,
				IssuerAppID:     "app1",
				ReceiverAppID:   "app1",
				Scopes:          []string{"read"},
				Status:          "active",
				ExpiresAt:       now.Add(time.Minute),
				ConstraintsJSON: []byte(`{"max_hops":3}`),
			},
			"edge1": mainEdge,
		},
	}
	srv := &Server{db: db}
	proof, _, err := srv.validateSessionReferences(context.Background(), "zone1", "app2", TokenExchangeRequest{
		SessionID:        target.ID,
		DelegationEdgeID: "edge1",
		Scope:            "read",
	}, true)
	if err != nil || proof == nil || len(proof.path) != 2 || proof.graphEpoch != 12 {
		t.Fatalf("want deep delegation proof, got proof=%#v err=%#v", proof, err)
	}
}

func TestValidateAncestorAttenuationResolvesCanonicalResourceIDs(t *testing.T) {
	resourceID := "resource-row-id"
	srv := &Server{db: &stubDB{resource: &Resource{ID: resourceID, ZoneID: "zone1", Identifier: "resource://pipernet"}}}
	parent := &DelegationEdge{ZoneID: "zone1", Scopes: []string{"read"}, ExpiresAt: time.Now().Add(time.Hour)}
	child := &DelegationEdge{ZoneID: "zone1", ResourceID: &resourceID, Scopes: []string{"read"}, ExpiresAt: time.Now().Add(time.Minute)}

	err := srv.validateAncestorAttenuation(
		context.Background(),
		parent,
		delegationConstraints{Resources: []string{"resource://pipernet"}, MaxHops: 2},
		child,
		delegationConstraints{MaxHops: 1},
	)

	if err != nil {
		t.Fatalf("canonical resource id must remain inside the ancestor resource identifier: %v", err)
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
			SessionID:       "agent-dst",
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

func makeTestSecretRow(t *testing.T, zek []byte, priv *ecdsa.PrivateKey, kid string) SecretRow {
	der, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal private key: %v", err)
	}
	keyBytes := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	envelope, err := secretstore.Seal(zek, keyBytes, secretstore.AADZoneSigningKey)
	if err != nil {
		t.Fatalf("seal key: %v", err)
	}
	return SecretRow{
		ID:       kid,
		Envelope: envelope,
	}
}

func TestValidateSubjectTokenGracePeriodAndRotation(t *testing.T) {
	// Setup keys and environment
	zek := []byte("12345678901234567890123456789012")
	keyCache := newKeyCache(nil, testKeyring(zek)) // We will supply the db below

	keyA, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key A: %v", err)
	}
	keyB, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key B: %v", err)
	}

	secretA := makeTestSecretRow(t, zek, keyA, "key-A")
	secretB := makeTestSecretRow(t, zek, keyB, "key-B")

	db := &stubDB{
		secrets: []SecretRow{secretB, secretA}, // B is active/newest, A is grace-period/older
	}
	keyCache.db = db

	srv := &Server{
		cfg:  Config{IssuerURL: "https://sts.example.com"},
		keys: keyCache,
		db:   db,
	}

	// Helper to mint tokens
	mintToken := func(priv *ecdsa.PrivateKey, kid string, useSession bool) string {
		now := time.Now()
		audience := []string{"https://sts.example.com"}
		use := UseSession
		if !useSession {
			use = UseResource
		}
		claims := Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "https://sts.example.com",
				Subject:   "user-123",
				Audience:  audience,
				ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
				IssuedAt:  jwt.NewNumericDate(now),
				ID:        uuid.NewString(),
			},
			ZoneID: "zone-1",
			Use:    use,
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
		if kid != "" {
			tok.Header["kid"] = kid
		}
		sig, err := tok.SignedString(priv)
		if err != nil {
			t.Fatalf("sign token: %v", err)
		}
		return sig
	}

	t.Run("AcceptsActiveKey", func(t *testing.T) {
		tok := mintToken(keyB, "key-B", true)
		claims, err := srv.validateSubjectToken(context.Background(), tok, "zone-1")
		if err != nil {
			t.Fatalf("expected active key to be accepted: %v", err)
		}
		if claims["sub"] != "user-123" {
			t.Errorf("expected subject user-123, got %v", claims["sub"])
		}
	})

	t.Run("AcceptsGracePeriodKey", func(t *testing.T) {
		tok := mintToken(keyA, "key-A", true)
		claims, err := srv.validateSubjectToken(context.Background(), tok, "zone-1")
		if err != nil {
			t.Fatalf("expected grace period key to be accepted: %v", err)
		}
		if claims["sub"] != "user-123" {
			t.Errorf("expected subject user-123, got %v", claims["sub"])
		}
	})

	t.Run("RejectsExpiredGracePeriodKey", func(t *testing.T) {
		activeOnlyDB := &stubDB{
			secrets: []SecretRow{secretB},
		}
		activeOnlySrv := &Server{
			cfg:  Config{IssuerURL: "https://sts.example.com"},
			keys: newKeyCache(activeOnlyDB, testKeyring(zek)),
			db:   activeOnlyDB,
		}
		tok := mintToken(keyA, "key-A", true)
		_, err := activeOnlySrv.validateSubjectToken(context.Background(), tok, "zone-1")
		if err == nil {
			t.Fatal("expected expired grace period key to be rejected, got nil error")
		}
	})

	t.Run("RejectsUnknownKid", func(t *testing.T) {
		otherKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatalf("generate unknown kid key: %v", err)
		}
		tok := mintToken(otherKey, "unknown-kid", true)
		_, err = srv.validateSubjectToken(context.Background(), tok, "zone-1")
		if err == nil {
			t.Fatal("expected failure for unknown kid, got nil error")
		}
	})

	t.Run("RejectsMissingKid", func(t *testing.T) {
		tok := mintToken(keyB, "", true)
		_, err := srv.validateSubjectToken(context.Background(), tok, "zone-1")
		if err == nil {
			t.Fatal("expected failure for missing kid, got nil error")
		}
	})

	t.Run("RejectsResourceMandate", func(t *testing.T) {
		tok := mintToken(keyB, "key-B", false)
		_, err := srv.validateSubjectToken(context.Background(), tok, "zone-1")
		if err == nil {
			t.Fatal("expected resource mandate token to be rejected, got nil error")
		} else if err.Error() != "subject_token must be a session mandate" {
			t.Fatalf("expected rejection due to session mandate requirement, got: %v", err)
		}
	})
}

func TestMintScopeSelfDescribesGatewayMandate(t *testing.T) {
	presented := map[string]any{"scope": "cordoba:read treasury:wire"}

	gateway := mintScope(TokenExchangeRequest{GatewayAuthenticated: true}, presented)
	if gateway != "cordoba:read treasury:wire" {
		t.Fatalf("a Gateway re-exchange must inherit the presented mandate's scope, got %q", gateway)
	}

	explicit := mintScope(TokenExchangeRequest{Scope: "agent:lifecycle"}, presented)
	if explicit != "agent:lifecycle" {
		t.Fatalf("an explicit scope request must mint exactly those scopes, got %q", explicit)
	}

	bootstrap := mintScope(TokenExchangeRequest{GatewayAuthenticated: true}, map[string]any{})
	if bootstrap != "" {
		t.Fatalf("a presented mandate with no scope claim must mint no scope, got %q", bootstrap)
	}
}

func TestGatewayActionInputSurfacesOperationOnlyForGatewayAuth(t *testing.T) {
	withOp := gatewayActionInput(TokenExchangeRequest{
		GatewayAuthenticated: true,
		RequestMethod:        "post",
		RequestPath:          " /api/initiate_payment ",
	})
	if withOp.ID != "TokenExchange" {
		t.Fatalf("action id: got %q", withOp.ID)
	}
	if withOp.Method != "POST" {
		t.Fatalf("method should be upper-cased and trimmed: got %q", withOp.Method)
	}
	if withOp.Path != "/api/initiate_payment" {
		t.Fatalf("path should be trimmed: got %q", withOp.Path)
	}

	forged := gatewayActionInput(TokenExchangeRequest{
		GatewayAuthenticated: false,
		RequestMethod:        "POST",
		RequestPath:          "/api/initiate_payment",
	})
	if forged.Method != "" || forged.Path != "" {
		t.Fatalf("non-gateway exchange must not surface a forgeable operation: got %q %q", forged.Method, forged.Path)
	}
}
