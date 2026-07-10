// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS admin authorization, step-up approval, JWKS, and readiness handler tests.

package internal

import (
	"context"
	"crypto/elliptic"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	secretstore "github.com/garudex-labs/caracal/packages/core/go/secretstore"
	"github.com/rs/zerolog"
)

// stepUpDB serves scripted step-up challenges on top of the shared stub.
type stepUpDB struct {
	stubDB
	challenge *StepUpChallengePG
	decideErr error
	decided   []DecideStepUpParams
}

func (d *stepUpDB) GetStepUpChallenge(_ context.Context, _ string) (*StepUpChallengePG, error) {
	if d.challenge == nil {
		return nil, errors.New("not found")
	}
	return d.challenge, nil
}

func (d *stepUpDB) DecideStepUpChallenge(_ context.Context, p DecideStepUpParams) error {
	if d.decideErr != nil {
		return d.decideErr
	}
	d.decided = append(d.decided, p)
	return nil
}

func pathValueRequest(method, target, body, id string) *http.Request {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	req.SetPathValue("id", id)
	return req
}

func TestStepUpStatusReportsChallengeState(t *testing.T) {
	server := testSTSServer(t)
	approver := "subject:pseudonym:deadbeef"
	satisfied := time.Now().UTC()
	expires := time.Now().Add(time.Minute).UTC()
	server.db = &stepUpDB{challenge: &StepUpChallengePG{
		ID:                "b3b8f7ce-0000-4000-8000-000000000001",
		ChallengeType:     humanApprovalChallengeType,
		ExpiresAt:         expires,
		SatisfiedAt:       &satisfied,
		ApproverSubjectID: &approver,
	}}

	w := httptest.NewRecorder()
	server.handleStepUpStatus(w, pathValueRequest(http.MethodGet, "/step-up/x", "", "b3b8f7ce-0000-4000-8000-000000000001"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"state":"approved"`) || !strings.Contains(body, `"expires_at"`) {
		t.Fatalf("state wrong: %s", body)
	}
	if strings.Contains(body, approver) || strings.Contains(body, "metadata") {
		t.Fatalf("status must disclose lifecycle state only: %s", body)
	}

	w = httptest.NewRecorder()
	server.handleStepUpStatus(w, pathValueRequest(http.MethodGet, "/step-up/x?wait=oops", "", "b3b8f7ce-0000-4000-8000-000000000001"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid wait status = %d", w.Code)
	}

	server.db = &stepUpDB{}
	w = httptest.NewRecorder()
	server.handleStepUpStatus(w, pathValueRequest(http.MethodGet, "/step-up/x", "", "b3b8f7ce-0000-4000-8000-000000000001"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing challenge status = %d", w.Code)
	}
}

func TestStepUpDecisionAuthorizationAndValidation(t *testing.T) {
	id := "b3b8f7ce-0000-4000-8000-000000000001"
	validBody := `{"decision":"approved","binding":"aa"}`

	authorize := func(req *http.Request) *http.Request {
		req.Header.Set("Authorization", "Bearer session-mandate")
		return req
	}

	t.Run("malformed challenge id", func(t *testing.T) {
		server := testSTSServer(t)
		w := httptest.NewRecorder()
		server.handleStepUpDecision(w, authorize(pathValueRequest(http.MethodPost, "/decision", validBody, "not-a-uuid")))
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("missing bearer is challenged", func(t *testing.T) {
		server := testSTSServer(t)
		w := httptest.NewRecorder()
		server.handleStepUpDecision(w, pathValueRequest(http.MethodPost, "/decision", validBody, id))
		if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("status=%d headers=%v", w.Code, w.Header())
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		server := testSTSServer(t)
		w := httptest.NewRecorder()
		server.handleStepUpDecision(w, authorize(pathValueRequest(http.MethodPost, "/decision", "{not json", id)))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("unknown decision verb", func(t *testing.T) {
		server := testSTSServer(t)
		w := httptest.NewRecorder()
		server.handleStepUpDecision(w, authorize(pathValueRequest(http.MethodPost, "/decision", `{"decision":"maybe","binding":"aa"}`, id)))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("oversized reason", func(t *testing.T) {
		server := testSTSServer(t)
		body := `{"decision":"rejected","binding":"aa","reason":"` + strings.Repeat("x", stepUpReasonMaxLength+1) + `"}`
		w := httptest.NewRecorder()
		server.handleStepUpDecision(w, authorize(pathValueRequest(http.MethodPost, "/decision", body, id)))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("no live challenge", func(t *testing.T) {
		server := testSTSServer(t)
		server.db = &stepUpDB{}
		w := httptest.NewRecorder()
		server.handleStepUpDecision(w, authorize(pathValueRequest(http.MethodPost, "/decision", validBody, id)))
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("invalid session mandate", func(t *testing.T) {
		server := testSTSServer(t)
		server.keys = newKeyCache(&stubDB{}, testKeyring(testKEK(1)))
		server.db = &stepUpDB{challenge: &StepUpChallengePG{
			ID:            id,
			ZoneID:        "zone-1",
			ChallengeType: humanApprovalChallengeType,
			ApproverClass: ApproverClassSubject,
			ExpiresAt:     time.Now().Add(time.Minute),
		}}
		w := httptest.NewRecorder()
		server.handleStepUpDecision(w, authorize(pathValueRequest(http.MethodPost, "/decision", validBody, id)))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("a garbage bearer must fail mandate validation, got %d body=%s", w.Code, w.Body.String())
		}
	})
}

func TestApproverRecordIDAppliesPrivacyMode(t *testing.T) {
	if got := approverRecordID(PrivacyIdentified, "z1", "user-1"); got != "subject:user-1" {
		t.Errorf("identified must store the subject verbatim, got %q", got)
	}
	if got := approverRecordID(PrivacyAnonymous, "z1", "user-1"); got != "subject:redacted" {
		t.Errorf("anonymous must store only a redaction marker, got %q", got)
	}
	pseudo := approverRecordID(PrivacyPseudonymous, "z1", "user-1")
	if !strings.HasPrefix(pseudo, "subject:pseudonym:") || strings.Contains(pseudo, "user-1") {
		t.Errorf("pseudonymous must not carry the subject, got %q", pseudo)
	}
	if pseudo != approverRecordID(PrivacyPseudonymous, "z1", "user-1") {
		t.Error("pseudonym must be stable for one subject in one zone")
	}
	if pseudo == approverRecordID(PrivacyPseudonymous, "z2", "user-1") {
		t.Error("pseudonym must not correlate across zones")
	}
}

// jwksDB serves scripted signing key secrets on top of the shared stub.
type jwksDB struct {
	stubDB
	rows []SecretRow
	err  error
}

func (d *jwksDB) GetZoneSigningKeySecrets(_ context.Context, _ string) ([]SecretRow, error) {
	return d.rows, d.err
}

func sealedSecret(t *testing.T, zek []byte, kid string, plaintext []byte) SecretRow {
	t.Helper()
	envelope, err := secretstore.Seal(zek, plaintext, secretstore.AADZoneSigningKey)
	if err != nil {
		t.Fatal(err)
	}
	return SecretRow{ID: kid, Envelope: envelope}
}

func TestJWKSKeyDecryptionBranches(t *testing.T) {
	zek := make([]byte, 32)
	for i := range zek {
		zek[i] = byte(i + 1)
	}
	pemKey := []byte(ecKeyPEM(t, elliptic.P256()))

	jwksServer := func(db DBQuerier) *Server {
		server := testSTSServer(t)
		server.db = db
		server.keys = newKeyCache(db, testKeyring(zek))
		return server
	}

	t.Run("missing keys are 404", func(t *testing.T) {
		w := httptest.NewRecorder()
		jwksServer(&jwksDB{err: errors.New("no rows")}).handleJWKS(w, httptest.NewRequest(http.MethodGet, "/jwks?zone_id=zone-1", nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("all keys undecryptable is 500", func(t *testing.T) {
		server := jwksServer(&jwksDB{rows: []SecretRow{{ID: "kid-bad", Envelope: []byte("garbage")}}})
		w := httptest.NewRecorder()
		server.handleJWKS(w, httptest.NewRequest(http.MethodGet, "/jwks?zone_id=zone-1", nil))
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
		}
		if server.metrics.JWKSInvalidKeys.Load() != 1 {
			t.Fatal("invalid key metric must record the skip")
		}
	})

	t.Run("valid keys are served with invalid ones skipped", func(t *testing.T) {
		server := jwksServer(&jwksDB{rows: []SecretRow{
			sealedSecret(t, zek, "kid-good", pemKey),
			sealedSecret(t, zek, "kid-not-ec", []byte("not a key")),
			{ID: "kid-bad", Envelope: []byte("garbage")},
		}})
		w := httptest.NewRecorder()
		server.handleJWKS(w, httptest.NewRequest(http.MethodGet, "/jwks?zone_id=zone-1", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
		}
		body := w.Body.String()
		if !strings.Contains(body, "kid-good") || strings.Contains(body, "kid-bad") || strings.Contains(body, "kid-not-ec") {
			t.Fatalf("jwks must contain only the valid key: %s", body)
		}
		if !strings.Contains(w.Header().Get("Cache-Control"), "max-age=") || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("cache and content-type headers required: %v", w.Header())
		}
		if server.metrics.JWKSInvalidKeys.Load() != 2 {
			t.Fatalf("skips = %d, want 2", server.metrics.JWKSInvalidKeys.Load())
		}
	})
}

// pingFailDB reports postgres as unreachable on top of the shared stub.
type pingFailDB struct{ stubDB }

func (pingFailDB) Ping(context.Context) error { return errors.New("pg down") }

func TestReadyFailureBranches(t *testing.T) {
	assertReason := func(t *testing.T, server *Server, reason string) {
		t.Helper()
		w := httptest.NewRecorder()
		server.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), reason) {
			t.Fatalf("status=%d body=%s, want reason %s", w.Code, w.Body.String(), reason)
		}
	}

	pgDown := testSTSServer(t)
	pgDown.db = &pingFailDB{}
	assertReason(t, pgDown, "postgres_unreachable")

	noRedis := testSTSServer(t)
	noRedis.redis = nil
	assertReason(t, noRedis, "redis_unavailable")

	replayBroken := testSTSServer(t)
	replayBroken.auditBuffer = &AuditBuffer{log: zerolog.Nop(), replayDir: "/nonexistent/replay-dir", metrics: &STSMetrics{}}
	assertReason(t, replayBroken, "audit_replay_unavailable")

	consumersPending := testSTSServer(t)
	assertReason(t, consumersPending, "stream_consumers_not_ready")
}
