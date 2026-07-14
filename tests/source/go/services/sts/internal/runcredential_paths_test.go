// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Run credential endpoint path tests: resource and provider failures, challenge lifecycle, and mint outcomes.

package internal

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
	"github.com/rs/zerolog"
)

func runCredentialFlowServer(t *testing.T, db DBQuerier, policy string) *Server {
	t.Helper()
	zek := []byte("12345678901234567890123456789012")
	return &Server{
		db:          db,
		redis:       newMemSTSRedis(),
		opa:         runCredentialZoneEngine(t, "z1", policy),
		auditBuffer: &AuditBuffer{ch: make(chan AuditEvent, 100), log: zerolog.Nop()},
		keys:        &KeyCache{keyring: testKeyring(zek)},
		secrets:     secretstore.Opened(&builtinSecretBackend{db: db}, testKeyring(zek)),
		metrics:     &STSMetrics{},
		log:         zerolog.Nop(),
	}
}

func runCredentialFlowStub(t *testing.T) stubDB {
	t.Helper()
	hash, err := hashClientSecret("ws_good")
	if err != nil {
		t.Fatal(err)
	}
	workload := runCredentialWorkload()
	workload.SecretHash = hash
	return stubDB{workload: workload}
}

func runCredentialForm(extra url.Values) url.Values {
	form := url.Values{"workload_id": {"wl-1"}, "secret": {"ws_good"}, "env": {"PIPERNET_TOKEN"}}
	for key, values := range extra {
		form[key] = values
	}
	return form
}

func TestRunCredentialResourceFailures(t *testing.T) {
	t.Run("bindings malformed", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		db.workload.Bindings = []byte(`{broken`)
		srv := runCredentialFlowServer(t, &db, runCredentialAllowPolicy)
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "bindings are invalid") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("resource missing", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		db.resErr = errors.New("not found")
		srv := runCredentialFlowServer(t, &db, runCredentialAllowPolicy)
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "not found in the workload's zone") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("resource without provider", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		resource := runCredentialResource("provider1")
		resource.CredentialProviderID = nil
		db.resource = resource
		srv := runCredentialFlowServer(t, &db, runCredentialAllowPolicy)
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "has no credential provider") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("provider lookup fails", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		db.resource = runCredentialResource("provider1")
		srv := runCredentialFlowServer(t, &db, runCredentialAllowPolicy)
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "provider unavailable") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("provider config malformed", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		db.resource = runCredentialResource("provider1")
		db.provider = &ProviderConfig{ID: "provider1", ProviderKind: strPtr("api_key"), ConfigJSON: []byte(`{broken`)}
		srv := runCredentialFlowServer(t, &db, runCredentialAllowPolicy)
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "provider unavailable") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("rate limited", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		srv := runCredentialFlowServer(t, &db, runCredentialAllowPolicy)
		srv.redis = &fakeSTSRedis{failures: defaultMintRateLimit}
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("status = %d", w.Code)
		}
	})
}

func TestRunCredentialPolicyFailures(t *testing.T) {
	zek := []byte("12345678901234567890123456789012")

	t.Run("policy engine unavailable", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		db.resource = runCredentialResource("provider1")
		db.provider = runCredentialProvider(true)
		db.storeEnvelopes = runCredentialProviderSecret(t, zek)
		srv := runCredentialFlowServer(t, &db, runCredentialAllowPolicy)
		srv.opa = newOPAEngine(&stubDB{})
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("evaluation incomplete", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		db.resource = runCredentialResource("provider1")
		db.provider = runCredentialProvider(true)
		db.storeEnvelopes = runCredentialProviderSecret(t, zek)
		partial := `
package caracal.authz
result := {"decision": "deny", "evaluation_status": "partial", "determining_policies": [], "diagnostics": []}
`
		srv := runCredentialFlowServer(t, &db, partial)
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		// The engine rejects any non-complete evaluation status, so the mint fails
		// closed as a policy evaluation error rather than a usable decision.
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "policy evaluation unavailable") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("directive build failure", func(t *testing.T) {
		db := runCredentialFlowStub(t)
		db.resource = runCredentialResource("provider1")
		db.provider = &ProviderConfig{
			ID:           "provider1",
			ProviderKind: strPtr("api_key"),
			ConfigJSON:   []byte(`{"header_name":"X-Api-Key","allow_runtime_injection":true}`),
		}
		db.storeEnvelopes = testProviderSecret(t, zek, "provider1", `{}`)
		srv := runCredentialFlowServer(t, &db, runCredentialAllowPolicy)
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "upstream credential for resource") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
}

func runCredentialApprovalChallenge(t *testing.T) *StepUpChallengePG {
	t.Helper()
	return &StepUpChallengePG{
		ID:            "b3b8f7ce-0000-4000-8000-00000000f001",
		ZoneID:        "z1",
		ChallengeType: humanApprovalChallengeType,
		PrincipalID:   "wl-1",
		Tier:          "money",
		ApproverClass: ApproverClassOperator,
		PrivacyMode:   PrivacyIdentified,
		ResourceSetHash: hashApprovalBinding([]string{"resource://pipernet"}, []string{"pipernet:read"}, approvalBindingContext{
			PrincipalID: "wl-1",
			Bundle:      bundleInfoForState(&opaZoneState{}),
		}),
		ExpiresAt: time.Now().Add(time.Hour),
	}
}

func TestRunCredentialChallengeLifecycle(t *testing.T) {
	zek := []byte("12345678901234567890123456789012")
	now := time.Now()

	request := func(t *testing.T, mutate func(*StepUpChallengePG), consumeErr error) (int, string) {
		t.Helper()
		challenge := runCredentialApprovalChallenge(t)
		if mutate != nil {
			mutate(challenge)
		}
		db := &approvalFlowDB{
			stepUpDB:   stepUpDB{stubDB: runCredentialFlowStub(t), challenge: challenge},
			consumeErr: consumeErr,
		}
		db.stubDB.resource = runCredentialResource("provider1")
		db.stubDB.provider = runCredentialProvider(true)
		db.stubDB.storeEnvelopes = runCredentialProviderSecret(t, zek)
		srv := runCredentialFlowServer(t, db, runCredentialAllowPolicy)
		w := runCredentialRequest(t, srv, runCredentialForm(url.Values{"approval_id": {challenge.ID}}))
		return w.Code, w.Body.String()
	}

	t.Run("consumed", func(t *testing.T) {
		code, body := request(t, func(c *StepUpChallengePG) { c.ConsumedAt = &now }, nil)
		if code != http.StatusConflict || !strings.Contains(body, `"error":"approval_consumed"`) || !strings.Contains(body, "already used") {
			t.Fatalf("code=%d body=%s", code, body)
		}
	})
	t.Run("rejected", func(t *testing.T) {
		code, body := request(t, func(c *StepUpChallengePG) { c.RejectedAt = &now }, nil)
		if code != http.StatusForbidden || !strings.Contains(body, "rejected") {
			t.Fatalf("code=%d body=%s", code, body)
		}
	})
	t.Run("expired", func(t *testing.T) {
		code, body := request(t, func(c *StepUpChallengePG) { c.ExpiresAt = now.Add(-time.Minute) }, nil)
		if code != http.StatusUnauthorized || !strings.Contains(body, "expired") {
			t.Fatalf("code=%d body=%s", code, body)
		}
	})
	t.Run("pending resurfaces the hold", func(t *testing.T) {
		code, body := request(t, nil, nil)
		if code != http.StatusUnauthorized || !strings.Contains(body, "interaction_required") {
			t.Fatalf("code=%d body=%s", code, body)
		}
	})
	t.Run("binding mismatch", func(t *testing.T) {
		code, body := request(t, func(c *StepUpChallengePG) { c.ResourceSetHash = []byte("other") }, nil)
		if code != http.StatusUnauthorized || !strings.Contains(body, "bindings do not match") {
			t.Fatalf("code=%d body=%s", code, body)
		}
	})
	t.Run("approved mints the credential", func(t *testing.T) {
		code, body := request(t, func(c *StepUpChallengePG) { c.SatisfiedAt = &now }, nil)
		if code != http.StatusOK || !strings.Contains(body, "pipernet-api-key") {
			t.Fatalf("code=%d body=%s", code, body)
		}
	})
	t.Run("consume race loses precisely", func(t *testing.T) {
		code, body := request(t, func(c *StepUpChallengePG) { c.SatisfiedAt = &now }, errors.New("already consumed"))
		if code != http.StatusConflict || !strings.Contains(body, `"error":"approval_consumed"`) || !strings.Contains(body, "no longer valid") {
			t.Fatalf("code=%d body=%s", code, body)
		}
	})
}

func TestRunCredentialGateReleasesGrantedHold(t *testing.T) {
	zek := []byte("12345678901234567890123456789012")
	now := time.Now()
	run := func(t *testing.T, hold *StepUpChallengePG) (int, string) {
		t.Helper()
		db := &approvalFlowDB{stepUpDB: stepUpDB{stubDB: runCredentialFlowStub(t)}, hold: hold}
		db.stubDB.resource = runCredentialResource("provider1")
		db.stubDB.provider = runCredentialProvider(true)
		db.stubDB.storeEnvelopes = runCredentialProviderSecret(t, zek)
		srv := runCredentialFlowServer(t, db, runCredentialGatedPolicy)
		w := runCredentialRequest(t, srv, runCredentialForm(nil))
		return w.Code, w.Body.String()
	}

	approved := runCredentialApprovalChallenge(t)
	approved.SatisfiedAt = &now
	if code, body := run(t, approved); code != http.StatusOK || !strings.Contains(body, "pipernet-api-key") {
		t.Fatalf("granted hold must release the mint, code=%d body=%s", code, body)
	}

	rejected := runCredentialApprovalChallenge(t)
	rejected.RejectedAt = &now
	if code, body := run(t, rejected); code != http.StatusForbidden || !strings.Contains(body, "rejected") {
		t.Fatalf("rejected hold must deny, code=%d body=%s", code, body)
	}
}
