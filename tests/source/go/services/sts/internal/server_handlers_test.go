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

	sharedcrypto "github.com/garudex-labs/caracal/packages/core/go/crypto"
	"github.com/rs/zerolog"
)

// stepUpDB serves scripted step-up challenges on top of the shared stub.
type stepUpDB struct {
	stubDB
	challenge  *StepUpChallengePG
	approveErr error
	approved   []string
}

func (d *stepUpDB) GetStepUpChallenge(_ context.Context, _ string) (*StepUpChallengePG, error) {
	if d.challenge == nil {
		return nil, errors.New("not found")
	}
	return d.challenge, nil
}

func (d *stepUpDB) ApproveStepUpChallenge(_ context.Context, id, zoneID, approver string) error {
	if d.approveErr != nil {
		return d.approveErr
	}
	d.approved = append(d.approved, id+"|"+zoneID+"|"+approver)
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
	approver := "user:monica.hall@piedpiper.example"
	satisfied := time.Now().UTC()
	server.db = &stepUpDB{challenge: &StepUpChallengePG{
		ID:                "b3b8f7ce-0000-4000-8000-000000000001",
		ChallengeType:     "human_approval",
		ExpiresAt:         time.Now().Add(time.Minute).UTC(),
		SatisfiedAt:       &satisfied,
		ApproverSubjectID: &approver,
	}}

	w := httptest.NewRecorder()
	server.handleStepUpStatus(w, pathValueRequest(http.MethodGet, "/step-up/x", "", "b3b8f7ce-0000-4000-8000-000000000001"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"satisfied":true`) || !strings.Contains(body, `"consumed":false`) {
		t.Fatalf("state flags wrong: %s", body)
	}
	if !strings.Contains(body, `"metadata":{}`) {
		t.Fatalf("empty metadata must default to an object: %s", body)
	}

	server.db = &stepUpDB{}
	w = httptest.NewRecorder()
	server.handleStepUpStatus(w, pathValueRequest(http.MethodGet, "/step-up/x", "", "b3b8f7ce-0000-4000-8000-000000000001"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing challenge status = %d", w.Code)
	}
}

func TestApproveStepUpAuthorizationAndValidation(t *testing.T) {
	id := "b3b8f7ce-0000-4000-8000-000000000001"
	validBody := `{"zone_id":"zone-1","approver_subject_id":"user:monica.hall@piedpiper.example"}`

	authorize := func(req *http.Request) *http.Request {
		req.Header.Set("Authorization", "Bearer admin-token")
		return req
	}

	t.Run("hidden without admin token config", func(t *testing.T) {
		server := testSTSServer(t)
		w := httptest.NewRecorder()
		server.handleApproveStepUp(w, pathValueRequest(http.MethodPost, "/approve", validBody, id))
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("wrong bearer is challenged", func(t *testing.T) {
		server := testSTSServer(t)
		server.cfg.AdminToken = "admin-token"
		req := pathValueRequest(http.MethodPost, "/approve", validBody, id)
		req.Header.Set("Authorization", "Bearer wrong")
		w := httptest.NewRecorder()
		server.handleApproveStepUp(w, req)
		if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") == "" {
			t.Fatalf("status=%d headers=%v", w.Code, w.Header())
		}
	})

	t.Run("malformed challenge id", func(t *testing.T) {
		server := testSTSServer(t)
		server.cfg.AdminToken = "admin-token"
		w := httptest.NewRecorder()
		server.handleApproveStepUp(w, authorize(pathValueRequest(http.MethodPost, "/approve", validBody, "not-a-uuid")))
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		server := testSTSServer(t)
		server.cfg.AdminToken = "admin-token"
		w := httptest.NewRecorder()
		server.handleApproveStepUp(w, authorize(pathValueRequest(http.MethodPost, "/approve", "{not json", id)))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("missing required fields", func(t *testing.T) {
		server := testSTSServer(t)
		server.cfg.AdminToken = "admin-token"
		w := httptest.NewRecorder()
		server.handleApproveStepUp(w, authorize(pathValueRequest(http.MethodPost, "/approve", `{"zone_id":"zone-1"}`, id)))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("no pending challenge", func(t *testing.T) {
		server := testSTSServer(t)
		server.cfg.AdminToken = "admin-token"
		server.db = &stepUpDB{approveErr: errors.New("no rows")}
		w := httptest.NewRecorder()
		server.handleApproveStepUp(w, authorize(pathValueRequest(http.MethodPost, "/approve", validBody, id)))
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d", w.Code)
		}
	})

	t.Run("approval recorded", func(t *testing.T) {
		server := testSTSServer(t)
		server.cfg.AdminToken = "admin-token"
		db := &stepUpDB{}
		server.db = db
		w := httptest.NewRecorder()
		server.handleApproveStepUp(w, authorize(pathValueRequest(http.MethodPost, "/approve", validBody, id)))
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"approved":true`) {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
		if len(db.approved) != 1 || !strings.Contains(db.approved[0], "zone-1") {
			t.Fatalf("approval not persisted: %v", db.approved)
		}
	})
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
	ct, nonce, err := sharedcrypto.Seal(zek, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	return SecretRow{ID: kid, Ciphertext: ct, Nonce: nonce}
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
		server.keys = newKeyCache(db, zek)
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
		server := jwksServer(&jwksDB{rows: []SecretRow{{ID: "kid-bad", Ciphertext: []byte("garbage"), Nonce: make([]byte, 12)}}})
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
			{ID: "kid-bad", Ciphertext: []byte("garbage"), Nonce: make([]byte, 12)},
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
