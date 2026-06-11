// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS HTTP handler and exchange helper path tests.

package internal

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/rs/zerolog"
)

func TestSTSReadySuccessAndRedisFailure(t *testing.T) {
	server := testSTSServer(t)
	close(server.consumersReady)

	w := httptest.NewRecorder()
	server.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("ready status = %d body=%s", w.Code, w.Body.String())
	}

	server.redis = &fakeSTSRedis{pingErr: errRedisDown{}}
	w = httptest.NewRecorder()
	server.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "redis_unreachable") {
		t.Fatalf("redis failure status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestSTSMetricsHandlersAuthorizeAndRenderSnapshots(t *testing.T) {
	server := testSTSServer(t)
	server.cfg.MetricsBearer = "secret"
	server.metrics.GraphTraversals.Add(2)

	w := httptest.NewRecorder()
	server.handleMetrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized metrics status = %d", w.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	server.handleMetrics(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "caracal_sts_graph_traversals_total 2") {
		t.Fatalf("unexpected metrics response status=%d body=%s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/metrics.json", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	server.handleMetricsJSON(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("metrics json status = %d", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["sts"] == nil || body["opa"] == nil {
		t.Fatalf("metrics json missing sections: %#v", body)
	}
}

func TestSTSHealthStepUpAndWriteErrorResponses(t *testing.T) {
	w := httptest.NewRecorder()
	handleHealth(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("health status = %d", w.Code)
	}

	w = httptest.NewRecorder()
	writeStepUp(w, "req-1", &challengeState{ID: "challenge-1", ChallengeType: "webauthn", Secret: "secret", ExpiresAt: time.Unix(100, 0).UTC()})
	if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") == "" {
		t.Fatalf("step-up status=%d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
	}

	w = httptest.NewRecorder()
	writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "denied"))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "access_denied") {
		t.Fatalf("writeError status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestSTSStepUpStatusRejectsMalformedIDs(t *testing.T) {
	w := httptest.NewRecorder()
	testSTSServer(t).handleStepUpStatus(w, httptest.NewRequest(http.MethodGet, "/step-up/not-a-uuid", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("malformed challenge status = %d", w.Code)
	}
}

func TestSTSPureExchangeHelpers(t *testing.T) {
	if sessionInput("") != nil || sessionInput("sid").ID != "sid" {
		t.Fatal("sessionInput should preserve non-empty ids only")
	}
	if !sameTokenPrincipal(map[string]any{"sub": "u", "client_id": "app"}, map[string]any{"sub": "u"}) {
		t.Fatal("same subject with missing actor client should match")
	}
	if sameTokenPrincipal(map[string]any{"sub": "u", "client_id": "app1"}, map[string]any{"sub": "u", "client_id": "app2"}) {
		t.Fatal("different client ids should not match")
	}
	resourceID := "resource-1"
	proof := &delegationProof{
		edge: &DelegationEdge{
			ID:              "edge-1",
			SourceSessionID: "source",
			TargetSessionID: "target",
			ResourceID:      &resourceID,
			Scopes:          []string{"read"},
			EdgeVersion:     2,
		},
		path:       []string{"edge-1"},
		graphEpoch: 7,
	}
	input := delegationEdgeInput(proof)
	if input.ID != "edge-1" || input.ResourceID != resourceID || input.GraphEpoch != 7 {
		t.Fatalf("unexpected delegation input: %+v", input)
	}
	if delegationEdgeInput(nil) != nil {
		t.Fatal("nil delegation proof should produce nil OPA edge")
	}
}

func TestDecodeGatewayHMACKeyBranches(t *testing.T) {
	if key, err := decodeGatewayHMACKey(""); err != nil || key != nil {
		t.Fatalf("empty gateway key should decode to nil, got key=%v err=%v", key, err)
	}
	raw := hex.EncodeToString([]byte("12345678901234567890123456789012"))
	key, err := decodeGatewayHMACKey(raw)
	if err != nil || len(key) != 32 {
		t.Fatalf("valid gateway key len=%d err=%v", len(key), err)
	}
	if _, err := decodeGatewayHMACKey("not-hex"); err == nil {
		t.Fatal("invalid hex should fail")
	}
}

type errRedisDown struct{}

func (errRedisDown) Error() string { return "redis down" }

func testSTSServer(t *testing.T) *Server {
	t.Helper()
	return &Server{
		db:             &stubDB{},
		redis:          &fakeSTSRedis{},
		opa:            newOPAEngine(&stubDB{}),
		auditBuffer:    &AuditBuffer{log: zerolog.Nop(), replayDir: t.TempDir(), metrics: &STSMetrics{}},
		metrics:        &STSMetrics{},
		consumersReady: make(chan struct{}),
		log:            zerolog.Nop(),
	}
}

func TestSTSMetricsFailClosedWithoutBearerInPublishedMode(t *testing.T) {
	server := testSTSServer(t)
	server.cfg.Mode = "stable"
	server.cfg.MetricsBearer = ""
	w := httptest.NewRecorder()
	server.handleMetrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("published STS metrics without bearer must be 401, got %d", w.Code)
	}
	w = httptest.NewRecorder()
	server.handleMetricsJSON(w, httptest.NewRequest(http.MethodGet, "/metrics.json", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("published STS metrics.json without bearer must be 401, got %d", w.Code)
	}
}
