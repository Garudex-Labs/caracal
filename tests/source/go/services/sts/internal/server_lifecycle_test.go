// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Server lifecycle and handler tests: Run shutdown, subject-plane step-up decisions, and signing key rotation.

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

	"github.com/rs/zerolog"
)

func TestRunServesAndShutsDownCleanly(t *testing.T) {
	t.Setenv("AUDIT_HMAC_KEY", "")
	buf, err := newAuditBuffer(&fakeSTSRedis{}, zerolog.Nop(), false, t.TempDir(), &STSMetrics{})
	if err != nil {
		t.Fatal(err)
	}
	srv := testSTSServer(t)
	srv.auditBuffer = buf
	srv.cfg.Port = "0"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := srv.Run(ctx); err != nil {
		t.Fatalf("cancelled run must shut down cleanly: %v", err)
	}
}

func TestRunReturnsListenerError(t *testing.T) {
	t.Setenv("AUDIT_HMAC_KEY", "")
	buf, err := newAuditBuffer(&fakeSTSRedis{}, zerolog.Nop(), false, t.TempDir(), &STSMetrics{})
	if err != nil {
		t.Fatal(err)
	}
	srv := testSTSServer(t)
	srv.auditBuffer = buf
	srv.cfg.Port = "not-a-port"
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := srv.Run(ctx); err == nil {
		t.Fatal("unbindable port must surface a listener error")
	}
}

// lineageDB scripts session lineage answers on top of the shared step-up stub.
type lineageDB struct {
	stepUpDB
	related    bool
	relatedErr error
}

func (d *lineageDB) AuthorityRecordsRelated(context.Context, string, string, string) (bool, error) {
	return d.related, d.relatedErr
}

func stepUpDecisionChallenge() *StepUpChallengePG {
	return &StepUpChallengePG{
		ID:                "b3b8f7ce-0000-4000-8000-00000000d001",
		ZoneID:            "zone1",
		AuthorityRecordID: "sess-hold",
		ChallengeType:     humanApprovalChallengeType,
		PrincipalID:       "app1",
		ApplicationID:     "app1",
		Tier:              "money",
		ApproverClass:     ApproverClassSubject,
		PrivacyMode:       PrivacyIdentified,
		ResourceSetHash:   []byte{0xab},
		ExpiresAt:         time.Now().Add(time.Hour),
	}
}

func stepUpDecisionServer(t *testing.T, db DBQuerier) *Server {
	t.Helper()
	srv := testSTSServer(t)
	srv.db = db
	srv.keys = newKeyCache(db, testKeyring(exchangeFlowZEK()))
	srv.cfg.IssuerURL = "https://sts.piedpiper.example"
	return srv
}

func decisionStub(t *testing.T, challenge *StepUpChallengePG) stepUpDB {
	t.Helper()
	subject := "user-1"
	return stepUpDB{
		stubDB: stubDB{
			secrets: []SecretRow{sealedSecret(t, exchangeFlowZEK(), "kid-zone1", []byte(ecKeyPEM(t, elliptic.P256())))},
			session: &AuthorityRecord{
				ID:        "sess-approver",
				ZoneID:    "zone1",
				SubjectID: &subject,
				Status:    "active",
				ExpiresAt: time.Now().Add(time.Hour),
			},
		},
		challenge: challenge,
	}
}

func approverMandate(t *testing.T, srv *Server, subType string) string {
	t.Helper()
	token, _, err := issueToken(context.Background(), IssueParams{
		ZoneID:                "zone1",
		AppID:                 "app1",
		SubjectID:             "user-1",
		SubType:               subType,
		Use:                   UseSession,
		AuthorityRecordID:     "sess-approver",
		RootAuthorityRecordID: "sess-approver",
		TTL:                   time.Hour,
	}, srv.keys, srv.cfg.IssuerURL)
	if err != nil {
		t.Fatalf("issue approver mandate: %v", err)
	}
	return token
}

func decideStepUp(t *testing.T, srv *Server, mandate, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := pathValueRequest(http.MethodPost, "/step-up/x/decision", body, "b3b8f7ce-0000-4000-8000-00000000d001")
	req.Header.Set("Authorization", "Bearer "+mandate)
	w := httptest.NewRecorder()
	srv.handleStepUpDecision(w, req)
	return w
}

func TestStepUpDecisionSubjectApproval(t *testing.T) {
	approvedBody := `{"decision":"approved","binding":"ab","reason":"looks right"}`

	t.Run("subject approves the hold", func(t *testing.T) {
		db := &lineageDB{stepUpDB: decisionStub(t, stepUpDecisionChallenge())}
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), approvedBody)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
		}
		if len(db.decided) != 1 || !db.decided[0].Approve || db.decided[0].ApproverSubjectID != "subject:user-1" {
			t.Fatalf("decision record = %#v", db.decided)
		}
		if !strings.Contains(w.Body.String(), `"state"`) {
			t.Fatalf("decision must return the challenge state: %s", w.Body.String())
		}
	})

	t.Run("application mandates cannot approve", func(t *testing.T) {
		db := &lineageDB{stepUpDB: decisionStub(t, stepUpDecisionChallenge())}
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeApplication), approvedBody)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "user session") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("hold without application does not admit subjects", func(t *testing.T) {
		challenge := stepUpDecisionChallenge()
		challenge.ApplicationID = ""
		db := &lineageDB{stepUpDB: decisionStub(t, challenge)}
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), approvedBody)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "does not admit subject decisions") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("operator-only hold rejects subject decisions", func(t *testing.T) {
		challenge := stepUpDecisionChallenge()
		challenge.ApproverClass = ApproverClassOperator
		db := &lineageDB{stepUpDB: decisionStub(t, challenge)}
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), approvedBody)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "operator decision") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("session subject mismatch fails validation", func(t *testing.T) {
		db := &lineageDB{stepUpDB: decisionStub(t, stepUpDecisionChallenge())}
		other := "user-2"
		db.stubDB.session.SubjectID = &other
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), approvedBody)
		if w.Code != http.StatusForbidden {
			t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("related lineage cannot self-approve", func(t *testing.T) {
		db := &lineageDB{stepUpDB: decisionStub(t, stepUpDecisionChallenge()), related: true}
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), approvedBody)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "own session lineage") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("lineage lookup failure is unavailable", func(t *testing.T) {
		db := &lineageDB{stepUpDB: decisionStub(t, stepUpDecisionChallenge()), relatedErr: errors.New("pg down")}
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), approvedBody)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("binding mismatch conflicts", func(t *testing.T) {
		db := &lineageDB{stepUpDB: decisionStub(t, stepUpDecisionChallenge())}
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), `{"decision":"approved","binding":"ff"}`)
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "binding does not match") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("decided hold conflicts", func(t *testing.T) {
		db := &lineageDB{stepUpDB: decisionStub(t, stepUpDecisionChallenge())}
		db.decideErr = errors.New("not pending")
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), approvedBody)
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "not pending") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("pseudonymous hold masks the approver", func(t *testing.T) {
		challenge := stepUpDecisionChallenge()
		challenge.PrivacyMode = PrivacyPseudonymous
		db := &lineageDB{stepUpDB: decisionStub(t, challenge)}
		srv := stepUpDecisionServer(t, db)
		w := decideStepUp(t, srv, approverMandate(t, srv, SubTypeUser), `{"decision":"rejected","binding":"ab"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
		}
		if len(db.decided) != 1 || db.decided[0].Approve || !strings.HasPrefix(db.decided[0].ApproverSubjectID, "subject:pseudonym:") {
			t.Fatalf("decision record = %#v", db.decided)
		}
	})
}

func TestStepUpStatusWaitReturnsTerminalState(t *testing.T) {
	satisfied := time.Now().UTC()
	srv := testSTSServer(t)
	srv.db = &stepUpDB{challenge: &StepUpChallengePG{
		ID:            "b3b8f7ce-0000-4000-8000-00000000e001",
		ChallengeType: humanApprovalChallengeType,
		ExpiresAt:     time.Now().Add(time.Hour),
		SatisfiedAt:   &satisfied,
	}}
	w := httptest.NewRecorder()
	srv.handleStepUpStatus(w, pathValueRequest(http.MethodGet, "/step-up/x?wait=99", "", "b3b8f7ce-0000-4000-8000-00000000e001"))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"approved"`) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	srv.handleStepUpStatus(w, pathValueRequest(http.MethodGet, "/step-up/x?wait=-1", "", "b3b8f7ce-0000-4000-8000-00000000e001"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("negative wait status = %d", w.Code)
	}
}

// rotateFailDB fails signing key inserts on top of the shared stub.
type rotateFailDB struct{ stubDB }

func (rotateFailDB) InsertZoneSigningKeySecret(context.Context, string, []byte) (*SecretRow, error) {
	return nil, errors.New("insert failed")
}

func TestRotateZoneSigningKeyValidation(t *testing.T) {
	srv := testSTSServer(t)
	srv.cfg.AdminToken = "admin-token"
	srv.keys = newKeyCache(srv.db, testKeyring(exchangeFlowZEK()))

	authorize := func(req *http.Request) *http.Request {
		req.Header.Set("Authorization", "Bearer admin-token")
		return req
	}
	rotate := func(srv *Server, zoneID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/internal/zones/x/signing-key/rotate", nil)
		req.SetPathValue("zoneID", zoneID)
		w := httptest.NewRecorder()
		srv.handleRotateZoneSigningKey(w, authorize(req))
		return w
	}

	if w := rotate(srv, ""); w.Code != http.StatusBadRequest {
		t.Fatalf("empty zone id status = %d", w.Code)
	}

	failing := testSTSServer(t)
	failing.cfg.AdminToken = "admin-token"
	failing.db = &rotateFailDB{}
	failing.keys = newKeyCache(failing.db, testKeyring(exchangeFlowZEK()))
	if w := rotate(failing, "zone-1"); w.Code != http.StatusInternalServerError {
		t.Fatalf("insert failure status = %d", w.Code)
	}
}

func TestRotateZoneSigningKeyRequiresZone(t *testing.T) {
	if _, err := newKeyCache(&stubDB{}, testKeyring(exchangeFlowZEK())).RotateZoneSigningKey(context.Background(), ""); err == nil {
		t.Fatal("rotation without a zone id must fail")
	}
}

func TestGetPublicKeyAndKidPropagatesLoadFailure(t *testing.T) {
	cache := newKeyCache(&stubDB{secretsErr: errors.New("pg down")}, testKeyring(exchangeFlowZEK()))
	if _, _, err := cache.getPublicKeyAndKid(context.Background(), "zone-1"); err == nil {
		t.Fatal("missing signing key must fail")
	}

	db := &stubDB{secrets: []SecretRow{sealedSecret(t, exchangeFlowZEK(), "kid-1", []byte(ecKeyPEM(t, elliptic.P256())))}}
	cache = newKeyCache(db, testKeyring(exchangeFlowZEK()))
	pub, kid, err := cache.getPublicKeyAndKid(context.Background(), "zone-1")
	if err != nil || pub == nil || kid != "kid-1" {
		t.Fatalf("pub=%v kid=%q err=%v", pub, kid, err)
	}
}
