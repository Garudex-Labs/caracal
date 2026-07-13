// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Full token-exchange flow tests: mint outcomes, deny taxonomy, gateway signatures, challenges, and step-up gates.

package internal

import (
	"context"
	"crypto/elliptic"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
	"github.com/rs/zerolog"
)

func exchangeFlowZEK() []byte {
	zek := make([]byte, 32)
	for i := range zek {
		zek[i] = byte(i + 1)
	}
	return zek
}

func exchangeFlowDB(t *testing.T) *stubDB {
	t.Helper()
	hash, err := hashClientSecret("piper-secret")
	if err != nil {
		t.Fatalf("hash client secret: %v", err)
	}
	return &stubDB{
		app: &Application{
			ID:                 "app1",
			ZoneID:             "zone1",
			Name:               "Anton",
			RegistrationMethod: "managed",
			ClientSecretHash:   &hash,
		},
		resource: &Resource{
			ID:         "res1",
			ZoneID:     "zone1",
			Identifier: "resource://pipernet",
			Scopes:     []string{"pipernet:read"},
		},
		secrets: []SecretRow{sealedSecret(t, exchangeFlowZEK(), "kid-zone1", []byte(ecKeyPEM(t, elliptic.P256())))},
	}
}

func exchangeFlowServer(t *testing.T, db DBQuerier, policy string) *Server {
	t.Helper()
	return &Server{
		db:          db,
		redis:       newMemSTSRedis(),
		opa:         runCredentialZoneEngine(t, "zone1", policy),
		auditBuffer: &AuditBuffer{ch: make(chan AuditEvent, 256), log: zerolog.Nop()},
		keys:        newKeyCache(db, testKeyring(exchangeFlowZEK())),
		secrets:     secretstore.Opened(&builtinSecretBackend{db: db}, testKeyring(exchangeFlowZEK())),
		metrics:     &STSMetrics{},
		cfg:         Config{IssuerURL: "https://sts.piedpiper.example", MaxGrantTTLSeconds: 3600},
		log:         zerolog.Nop(),
	}
}

func sessionMandate(t *testing.T, srv *Server, sub, sid, scopes string) string {
	return mandate(t, srv, sub, sid, scopes, UseSession)
}

func gatewayMandate(t *testing.T, srv *Server, sub, sid, scopes string) string {
	return mandate(t, srv, sub, sid, scopes, UseGateway)
}

func mandate(t *testing.T, srv *Server, sub, sid, scopes, use string) string {
	t.Helper()
	token, _, err := issueToken(context.Background(), IssueParams{
		ZoneID:                "zone1",
		AppID:                 "app1",
		SubjectID:             sub,
		SubType:               SubTypeUser,
		Use:                   use,
		AuthorityRecordID:     sid,
		RootAuthorityRecordID: sid,
		Scopes:                scopes,
		TTL:                   time.Hour,
	}, srv.keys, srv.cfg.IssuerURL)
	if err != nil {
		t.Fatalf("issue session mandate: %v", err)
	}
	return token
}

func activeUserAuthorityRecord(sid string) *AuthorityRecord {
	subject := "user-1"
	return &AuthorityRecord{
		ID:          sid,
		ZoneID:      "zone1",
		SessionType: "user",
		SubjectID:   &subject,
		Status:      "active",
		ExpiresAt:   time.Now().Add(time.Hour),
	}
}

func exchangeHTTP(t *testing.T, srv *Server, form url.Values, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/oauth/2/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for key, values := range header {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	w := httptest.NewRecorder()
	srv.handleTokenExchange(w, req)
	return w
}

func TestExchangeMintsAuthorityRecordMandate(t *testing.T) {
	srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialAllowPolicy)
	w := exchangeHTTP(t, srv, url.Values{
		"grant_type":     {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"zone_id":        {"zone1"},
		"application_id": {"app1"},
		"client_secret":  {"piper-secret"},
		"resource":       {"resource://pipernet"},
		"scope":          {"pipernet:read"},
	}, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var resp TokenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.AccessToken == "" || resp.TokenType != "Bearer" {
		t.Fatalf("token response incomplete: %+v", resp)
	}
	if resp.ExpiresIn != int(ttlResourceMandate.Seconds()) {
		t.Fatalf("expires_in = %d, want %d", resp.ExpiresIn, int(ttlResourceMandate.Seconds()))
	}
	if len(resp.TargetResources) != 1 || resp.TargetResources[0] != "resource://pipernet" {
		t.Fatalf("target resources = %v", resp.TargetResources)
	}
	if resp.Scope != "pipernet:read" || len(resp.Upstreams) != 0 {
		t.Fatalf("public exchange must carry no upstream directives: %+v", resp)
	}
}

func TestExchangeGatewaySignedRequestMintsResourceMandate(t *testing.T) {
	db := exchangeFlowDB(t)
	db.session = activeUserAuthorityRecord("sess-1")
	db.resource.UpstreamURL = strPtr("https://api.pipernet.example")
	srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 7)
	}
	srv.cfg.GatewayHMACKey = key
	mandate := gatewayMandate(t, srv, "user-1", "sess-1", "pipernet:read")

	form := url.Values{
		"grant_type":         {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"zone_id":            {"zone1"},
		"application_id":     {"app1"},
		"subject_token":      {mandate},
		"subject_token_type": {"urn:ietf:params:oauth:token-type:access_token"},
		"resource":           {"resource://pipernet"},
	}
	requestID := "req-gateway-1"
	nonce := "nonce-gateway-1"
	form.Set("gateway_request_id", requestID)
	now := time.Now().UTC()
	signature := corests.SignGatewayExchange(key, now, nonce, http.MethodPost, "/oauth/2/token", []byte(form.Encode()))
	header := http.Header{}
	header.Set("X-Request-Id", requestID)
	header.Set(corests.GatewayTimestampHeader, strconv.FormatInt(now.Unix(), 10))
	header.Set(corests.GatewayRequestHeader, nonce)
	header.Set(corests.GatewaySignatureHeader, signature)

	w := exchangeHTTP(t, srv, form, header)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var resp TokenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Scope != "pipernet:read" {
		t.Fatalf("resource mandate must inherit the presented mandate scope, got %q", resp.Scope)
	}
	directive, ok := resp.Upstreams["resource://pipernet"]
	if !ok || directive.AuthMode != UpstreamAuthCaracalJWT || directive.URL != "https://api.pipernet.example" {
		t.Fatalf("gateway exchange must carry an upstream directive: %+v", resp.Upstreams)
	}

	replay := exchangeHTTP(t, srv, form, header)
	if replay.Code != http.StatusUnauthorized {
		t.Fatalf("replayed gateway nonce must be rejected, got %d", replay.Code)
	}
}

func TestExchangeHandlerRejectsMalformedRequests(t *testing.T) {
	srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialAllowPolicy)

	w := exchangeHTTP(t, srv, url.Values{"ttl_seconds": {"abc"}}, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid ttl_seconds status = %d", w.Code)
	}

	header := http.Header{}
	header.Set("X-Request-Id", "req-1")
	header.Set(corests.GatewayTimestampHeader, strconv.FormatInt(time.Now().Unix(), 10))
	header.Set(corests.GatewayRequestHeader, "req-other")
	header.Set(corests.GatewaySignatureHeader, "deadbeef")
	w = exchangeHTTP(t, srv, url.Values{"application_id": {"app1"}}, header)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("gateway request id mismatch status = %d", w.Code)
	}

	req := httptest.NewRequest(http.MethodPost, "/oauth/2/token", strings.NewReader("%zz"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	srv.handleTokenExchange(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed body status = %d", rec.Code)
	}
}

func baseExchangeRequest() TokenExchangeRequest {
	return TokenExchangeRequest{
		GrantType:     "urn:ietf:params:oauth:grant-type:token-exchange",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		ClientSecret:  "piper-secret",
		Resources:     []string{"resource://pipernet"},
		Scope:         "pipernet:read",
	}
}

func TestExchangeDenyTaxonomy(t *testing.T) {
	t.Run("missing resources", func(t *testing.T) {
		srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialAllowPolicy)
		req := baseExchangeRequest()
		req.Resources = nil
		_, _, code, apiErr := srv.exchange(context.Background(), req, "req-1")
		if code != http.StatusBadRequest || apiErr == nil {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})

	t.Run("unknown resource denies exchange", func(t *testing.T) {
		db := exchangeFlowDB(t)
		db.resource = nil
		db.resErr = errors.New("not found")
		srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
		_, _, code, apiErr := srv.exchange(context.Background(), baseExchangeRequest(), "req-1")
		if code != http.StatusForbidden || apiErr == nil || apiErr.Code != sharederr.AccessDenied {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})

	t.Run("scope mismatch denies exchange", func(t *testing.T) {
		srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialAllowPolicy)
		req := baseExchangeRequest()
		req.Scope = "pipernet:admin"
		_, _, code, _ := srv.exchange(context.Background(), req, "req-1")
		if code != http.StatusForbidden {
			t.Fatalf("code = %d", code)
		}
	})

	t.Run("rate limited resource is skipped", func(t *testing.T) {
		srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialAllowPolicy)
		srv.redis = &fakeSTSRedis{failures: defaultMintRateLimit}
		_, _, code, _ := srv.exchange(context.Background(), baseExchangeRequest(), "req-1")
		if code != http.StatusForbidden {
			t.Fatalf("code = %d", code)
		}
	})

	t.Run("policy deny", func(t *testing.T) {
		srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialDenyPolicy)
		_, _, code, apiErr := srv.exchange(context.Background(), baseExchangeRequest(), "req-1")
		if code != http.StatusForbidden || apiErr == nil || apiErr.Code != sharederr.AccessDenied {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})

	t.Run("policy engine unavailable", func(t *testing.T) {
		srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialAllowPolicy)
		srv.opa = newOPAEngine(&stubDB{})
		_, _, code, apiErr := srv.exchange(context.Background(), baseExchangeRequest(), "req-1")
		if code != http.StatusServiceUnavailable || apiErr == nil || apiErr.Code != sharederr.PolicyEvalFailed {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})

	// An engine evaluation error must land in audit as an actionable event: the
	// failure result names policy_eval_failed and carries the engine error text,
	// so the fault is diagnosable from evidence alone.
	t.Run("policy eval failure carries the engine error in diagnostics", func(t *testing.T) {
		failure := policyEvalFailure(errors.New("eval_conflict_error: complete rules must not produce multiple outputs"))
		if failure.Decision != "deny" || failure.EvaluationStatus != "policy_eval_failed" {
			t.Fatalf("failure result = %#v", failure)
		}
		if len(failure.Diagnostics) != 1 || !strings.Contains(fmt.Sprint(failure.Diagnostics[0]["error"]), "multiple outputs") {
			t.Fatalf("diagnostics must carry the engine error, got %#v", failure.Diagnostics)
		}
	})

	t.Run("invalid subject token", func(t *testing.T) {
		srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialAllowPolicy)
		req := baseExchangeRequest()
		req.SubjectToken = "not-a-jwt"
		_, _, code, _ := srv.exchange(context.Background(), req, "req-1")
		if code != http.StatusUnauthorized {
			t.Fatalf("code = %d", code)
		}
	})

	t.Run("resource exchange requires the gateway", func(t *testing.T) {
		db := exchangeFlowDB(t)
		db.session = activeUserAuthorityRecord("sess-1")
		srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
		req := baseExchangeRequest()
		req.SubjectToken = sessionMandate(t, srv, "user-1", "sess-1", "pipernet:read")
		_, _, code, apiErr := srv.exchange(context.Background(), req, "req-1")
		if code != http.StatusForbidden || apiErr == nil || !strings.Contains(apiErr.Description, "Gateway") {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})

	t.Run("ttl above session cap", func(t *testing.T) {
		srv := exchangeFlowServer(t, exchangeFlowDB(t), runCredentialAllowPolicy)
		req := baseExchangeRequest()
		req.TTLSeconds = int(ttlAuthorityRecordMandate.Seconds()) + 1
		_, _, code, _ := srv.exchange(context.Background(), req, "req-1")
		if code != http.StatusBadRequest {
			t.Fatalf("code = %d", code)
		}
	})

	t.Run("session insert failure", func(t *testing.T) {
		db := exchangeFlowDB(t)
		db.sessErr = errors.New("insert failed")
		srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
		_, _, code, _ := srv.exchange(context.Background(), baseExchangeRequest(), "req-1")
		if code != http.StatusInternalServerError {
			t.Fatalf("code = %d", code)
		}
	})
}

func TestExchangeRejectsActorToken(t *testing.T) {
	db := exchangeFlowDB(t)
	srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)

	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange")
	form.Set("zone_id", "zone1")
	form.Set("application_id", "app1")
	form.Set("actor_token", "any-token")
	req := httptest.NewRequest(http.MethodPost, "/oauth/2/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	srv.handleTokenExchange(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("actor_token code = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "actor_token is not supported") {
		t.Fatalf("actor_token body = %s", w.Body.String())
	}
}

func TestExchangeControlKeyCapsTTL(t *testing.T) {
	db := exchangeFlowDB(t)
	hash, err := hashClientSecret("control-secret")
	if err != nil {
		t.Fatal(err)
	}
	db.app = &Application{
		ID:                 "control-app",
		ZoneID:             "zone1",
		Name:               "Control key",
		RegistrationMethod: "managed",
		ClientSecretHash:   &hash,
		Traits: []string{
			controlInvokeTrait,
			controlScopeTrait + "control:agent:read",
			controlMaxTTLTrait + "120",
		},
	}
	db.resource = &Resource{
		ID:         "res-control",
		ZoneID:     "zone1",
		Identifier: defaultControlAudience,
		Scopes:     []string{"control:agent:read"},
	}
	srv := exchangeFlowServer(t, db, runCredentialDenyPolicy)
	resp, challenge, code, apiErr := srv.exchange(context.Background(), TokenExchangeRequest{
		GrantType:     "urn:ietf:params:oauth:grant-type:token-exchange",
		ZoneID:        "zone1",
		ApplicationID: "control-app",
		ClientSecret:  "control-secret",
		Resources:     []string{defaultControlAudience},
		Scope:         "control:agent:read",
	}, "req-control")
	if apiErr != nil || challenge != nil || code != http.StatusOK {
		t.Fatalf("code=%d challenge=%v err=%#v", code, challenge, apiErr)
	}
	if resp.ExpiresIn != 120 {
		t.Fatalf("control max-ttl trait must cap the token, got %d", resp.ExpiresIn)
	}
	if len(resp.TargetResources) != 1 || resp.TargetResources[0] != defaultControlAudience {
		t.Fatalf("target resources = %v", resp.TargetResources)
	}
}

func TestExchangeControlResourceRequiresControlKey(t *testing.T) {
	db := exchangeFlowDB(t)
	db.resource = &Resource{
		ID:         "res-control",
		ZoneID:     "zone1",
		Identifier: defaultControlAudience,
		Scopes:     []string{"control:agent:read"},
	}
	srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
	resp, challenge, code, apiErr := srv.exchange(context.Background(), TokenExchangeRequest{
		GrantType:     "urn:ietf:params:oauth:grant-type:token-exchange",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		ClientSecret:  "piper-secret",
		Resources:     []string{defaultControlAudience},
		Scope:         "control:agent:read",
	}, "req-control-deny")
	if resp != nil || challenge != nil {
		t.Fatalf("control resource must never mint for a non-control key: resp=%#v challenge=%#v", resp, challenge)
	}
	if code != http.StatusForbidden {
		t.Fatalf("code = %d, want %d (err=%#v)", code, http.StatusForbidden, apiErr)
	}
	if apiErr == nil || !strings.Contains(apiErr.Error(), "control key") {
		t.Fatalf("expected a control-key denial, got %#v", apiErr)
	}
}

func TestExchangeOperationFloor(t *testing.T) {
	db := exchangeFlowDB(t)
	db.session = activeUserAuthorityRecord("sess-1")
	db.resource.OperationEnforcement = OperationEnforcementEnforced
	db.resource.Operations = []ResourceOperation{{Method: "GET", Path: "/items", Scope: "pipernet:read"}}
	srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)

	req := baseExchangeRequest()
	req.ClientSecret = ""
	req.Scope = ""
	req.GatewayAuthenticated = true
	req.SubjectToken = gatewayMandate(t, srv, "user-1", "sess-1", "pipernet:read")
	req.RequestMethod = "get"
	req.RequestPath = "/items"
	resp, _, code, apiErr := srv.exchange(context.Background(), req, "req-op-1")
	if apiErr != nil || code != http.StatusOK || len(resp.TargetResources) != 1 {
		t.Fatalf("declared operation with scope must mint, code=%d err=%#v", code, apiErr)
	}

	req.RequestPath = "/admin"
	_, _, code, apiErr = srv.exchange(context.Background(), req, "req-op-2")
	if code != http.StatusForbidden || apiErr == nil || apiErr.Code != sharederr.OperationNotPermitted {
		t.Fatalf("undeclared operation must deny, code=%d err=%#v", code, apiErr)
	}
}

// approvalFlowDB scripts approval holds on top of the shared step-up stub.
type approvalFlowDB struct {
	stepUpDB
	hold        *StepUpChallengePG
	holdCreated bool
	consumeErr  error
}

func (d *approvalFlowDB) GetOrCreateApprovalChallenge(_ context.Context, c *StepUpChallengePG) (*StepUpChallengePG, bool, error) {
	if d.hold != nil {
		return d.hold, d.holdCreated, nil
	}
	return c, true, nil
}

func (d *approvalFlowDB) ConsumeApprovalChallenge(context.Context, ConsumeApprovalParams) error {
	return d.consumeErr
}

func (d *approvalFlowDB) InsertAuthorityRecordWithApproval(_ context.Context, sess *AuthorityRecord, _ ConsumeApprovalParams) error {
	if d.consumeErr != nil {
		return ErrChallengeInvalid
	}
	d.insertedAuthorityRecords = append(d.insertedAuthorityRecords, sess)
	return nil
}

func exchangeApprovalChallenge(t *testing.T) *StepUpChallengePG {
	t.Helper()
	return &StepUpChallengePG{
		ID:            "b3b8f7ce-0000-4000-8000-00000000c001",
		ZoneID:        "zone1",
		ChallengeType: humanApprovalChallengeType,
		PrincipalID:   "app1",
		ApplicationID: "app1",
		Tier:          "money",
		ApproverClass: ApproverClassOperator,
		PrivacyMode:   PrivacyIdentified,
		ResourceSetHash: hashApprovalBinding([]string{"resource://pipernet"}, []string{"pipernet:read"}, approvalBindingContext{
			PrincipalID:   "app1",
			ApplicationID: "app1",
			Bundle:        bundleInfoForState(&opaZoneState{}),
		}),
		ExpiresAt: time.Now().Add(time.Hour),
	}
}

func TestExchangeChallengeLifecycle(t *testing.T) {
	now := time.Now()
	run := func(t *testing.T, mutate func(*StepUpChallengePG), consumeErr error) (*TokenResponse, *challengeState, int, *sharederr.CaracalError) {
		t.Helper()
		challenge := exchangeApprovalChallenge(t)
		if mutate != nil {
			mutate(challenge)
		}
		db := &approvalFlowDB{stepUpDB: stepUpDB{stubDB: *exchangeFlowDB(t), challenge: challenge}, consumeErr: consumeErr}
		srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
		req := baseExchangeRequest()
		req.ChallengeID = challenge.ID
		return srv.exchange(context.Background(), req, "req-challenge")
	}

	t.Run("consumed", func(t *testing.T) {
		_, _, code, apiErr := run(t, func(c *StepUpChallengePG) { c.ConsumedAt = &now }, nil)
		if code != http.StatusConflict || apiErr == nil || apiErr.Code != sharederr.ApprovalConsumed || !strings.Contains(apiErr.Description, "already used") {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})
	t.Run("rejected", func(t *testing.T) {
		_, _, code, apiErr := run(t, func(c *StepUpChallengePG) { c.RejectedAt = &now }, nil)
		if code != http.StatusForbidden || apiErr == nil || !strings.Contains(apiErr.Description, "rejected") {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})
	t.Run("expired", func(t *testing.T) {
		_, _, code, apiErr := run(t, func(c *StepUpChallengePG) { c.ExpiresAt = now.Add(-time.Minute) }, nil)
		if code != http.StatusUnauthorized || apiErr == nil || !strings.Contains(apiErr.Description, "expired") {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})
	t.Run("pending resurfaces the challenge", func(t *testing.T) {
		_, challenge, code, apiErr := run(t, nil, nil)
		if code != http.StatusUnauthorized || apiErr != nil || challenge == nil || challenge.State != ChallengeStatePending {
			t.Fatalf("code=%d challenge=%+v err=%#v", code, challenge, apiErr)
		}
	})
	t.Run("binding mismatch", func(t *testing.T) {
		_, _, code, apiErr := run(t, func(c *StepUpChallengePG) { c.ResourceSetHash = []byte("other") }, nil)
		if code != http.StatusUnauthorized || apiErr == nil || !strings.Contains(apiErr.Description, "bindings do not match") {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})
	t.Run("approved mints and consumes", func(t *testing.T) {
		resp, _, code, apiErr := run(t, func(c *StepUpChallengePG) { c.SatisfiedAt = &now }, nil)
		if code != http.StatusOK || apiErr != nil || resp == nil || resp.AccessToken == "" {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})
	t.Run("consume race loses precisely", func(t *testing.T) {
		_, _, code, apiErr := run(t, func(c *StepUpChallengePG) { c.SatisfiedAt = &now }, errors.New("already consumed"))
		if code != http.StatusConflict || apiErr == nil || apiErr.Code != sharederr.ApprovalConsumed || !strings.Contains(apiErr.Description, "no longer valid") {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})
}

func TestExchangeStepUpGate(t *testing.T) {
	now := time.Now()
	run := func(t *testing.T, hold *StepUpChallengePG) (*TokenResponse, *challengeState, int, *sharederr.CaracalError) {
		t.Helper()
		db := &approvalFlowDB{stepUpDB: stepUpDB{stubDB: *exchangeFlowDB(t)}, hold: hold}
		srv := exchangeFlowServer(t, db, runCredentialGatedPolicy)
		return srv.exchange(context.Background(), baseExchangeRequest(), "req-gate")
	}

	t.Run("fresh hold pauses the mint", func(t *testing.T) {
		_, challenge, code, apiErr := run(t, nil)
		if code != http.StatusUnauthorized || apiErr != nil || challenge == nil {
			t.Fatalf("code=%d challenge=%+v err=%#v", code, challenge, apiErr)
		}
		if challenge.State != ChallengeStatePending || challenge.Tier != "money" {
			t.Fatalf("hold shape wrong: %+v", challenge)
		}
	})
	t.Run("granted hold releases the mint", func(t *testing.T) {
		hold := exchangeApprovalChallenge(t)
		hold.SatisfiedAt = &now
		resp, _, code, apiErr := run(t, hold)
		if code != http.StatusOK || apiErr != nil || resp == nil || resp.AccessToken == "" {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})
	t.Run("rejected hold denies the mint", func(t *testing.T) {
		hold := exchangeApprovalChallenge(t)
		hold.RejectedAt = &now
		_, _, code, apiErr := run(t, hold)
		if code != http.StatusForbidden || apiErr == nil || !strings.Contains(apiErr.Description, "rejected") {
			t.Fatalf("code=%d err=%#v", code, apiErr)
		}
	})
}

func TestExchangeSessionOwnership(t *testing.T) {
	agent := func(app, status string) *Session {
		return &Session{
			ID:            "agent-1",
			ZoneID:        "zone1",
			ApplicationID: app,
			Lifecycle:     "task",
			Status:        status,
			StartedAt:     time.Now().Add(-time.Minute),
			TTLSeconds:    600,
		}
	}
	run := func(t *testing.T, session *Session) (int, *sharederr.CaracalError) {
		t.Helper()
		db := exchangeFlowDB(t)
		db.sessions = []*Session{session}
		srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
		req := baseExchangeRequest()
		req.SessionID = "agent-1"
		_, _, code, apiErr := srv.exchange(context.Background(), req, "req-agent")
		return code, apiErr
	}

	if code, apiErr := run(t, agent("app1", "active")); code != http.StatusOK || apiErr != nil {
		t.Fatalf("owned active Session must mint, code=%d err=%#v", code, apiErr)
	}
	if code, apiErr := run(t, agent("app2", "active")); code != http.StatusForbidden || apiErr == nil || !strings.Contains(apiErr.Description, "not owned") {
		t.Fatalf("peer-owned Session must deny, code=%d err=%#v", code, apiErr)
	}
	if code, apiErr := run(t, agent("app1", "revoked")); code != http.StatusForbidden || apiErr == nil || !strings.Contains(apiErr.Description, "inactive") {
		t.Fatalf("revoked Session must deny, code=%d err=%#v", code, apiErr)
	}
}
