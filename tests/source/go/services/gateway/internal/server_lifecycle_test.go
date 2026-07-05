// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway server lifecycle tests: construction, readiness, metrics handlers, and run/shutdown.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/audit"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

// fakeGatewayRedis satisfies gatewayRedis, jtiRedis, and audit.Streamer so a
// full Server can run against in-memory dependencies.
type fakeGatewayRedis struct {
	fakeRevocationRedis
	pingErr error
}

func (f *fakeGatewayRedis) Ping(context.Context) error {
	return f.pingErr
}

func (f *fakeGatewayRedis) XAdd(context.Context, string, map[string]any) error {
	return nil
}

func (f *fakeGatewayRedis) SetNXTTL(context.Context, string, string, time.Duration) (bool, error) {
	return true, nil
}

func (f *fakeGatewayRedis) XReadGroup(ctx context.Context, _, _, _ string, _ int64) ([]redis.XMessage, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// revisionPool answers every binding query with a stable revision row so
// ReloadIfChanged reports no change.
type revisionPool struct{}

func (revisionPool) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	return rowValues([]any{int64(0)}), nil
}

// errBindingPool fails every query to simulate an unreachable Postgres.
type errBindingPool struct{ err error }

func (p errBindingPool) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	return nil, p.err
}

func newTestAuditClient(t *testing.T, dir string) *audit.Client {
	t.Helper()
	client, err := audit.NewClient(&fakeGatewayRedis{}, audit.ClientConfig{ReplayDir: dir, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatalf("audit client: %v", err)
	}
	return client
}

func newGatewayTestServer(t *testing.T) *Server {
	t.Helper()
	tracker, err := newJTITracker(&fakeGatewayRedis{}, zerolog.Nop(), false, nil)
	if err != nil {
		t.Fatalf("jti tracker: %v", err)
	}
	revocations := newRevocationStore(zerolog.Nop())
	revocations.markSnapshotFresh(time.Now())
	return &Server{
		cfg:         Config{Mode: "dev", Port: "0", MaxRequestBytes: 1 << 20, UpstreamTimeout: time.Second},
		log:         zerolog.Nop(),
		sts:         newSTSClient("http://127.0.0.1:1", time.Second, nil),
		jwks:        newJWKSCache("http://127.0.0.1:1", time.Second, zerolog.Nop()),
		guard:       newUpstreamGuard(nil),
		tracker:     tracker,
		bindings:    newTestBindingStore(revisionPool{}),
		redis:       &fakeGatewayRedis{},
		audit:       newTestAuditClient(t, t.TempDir()),
		revocations: revocations,
		metrics:     &GatewayMetrics{},
	}
}

func readyReason(t *testing.T, s *Server) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	var body struct {
		Ready  bool   `json:"ready"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(w.Result().Body).Decode(&body); err != nil {
		t.Fatalf("decode ready response: %v", err)
	}
	return w.Result().StatusCode, body.Reason
}

func TestHandleReadyReportsEachDependencyFailure(t *testing.T) {
	s := newGatewayTestServer(t)
	s.bindings = nil
	if _, reason := readyReason(t, s); reason != "bindings_unavailable" {
		t.Fatalf("reason = %q", reason)
	}

	s = newGatewayTestServer(t)
	s.bindings = newTestBindingStore(errBindingPool{err: errors.New("pg down")})
	if _, reason := readyReason(t, s); reason != "postgres_unreachable" {
		t.Fatalf("reason = %q", reason)
	}

	s = newGatewayTestServer(t)
	s.redis = &fakeGatewayRedis{pingErr: errors.New("redis down")}
	if _, reason := readyReason(t, s); reason != "redis_unreachable" {
		t.Fatalf("reason = %q", reason)
	}

	s = newGatewayTestServer(t)
	s.revocations = newRevocationStore(zerolog.Nop())
	if _, reason := readyReason(t, s); reason != "revocation_snapshot_stale" {
		t.Fatalf("reason = %q", reason)
	}

	s = newGatewayTestServer(t)
	replayDir := t.TempDir()
	s.audit = newTestAuditClient(t, replayDir)
	if err := os.RemoveAll(replayDir); err != nil {
		t.Fatalf("remove replay dir: %v", err)
	}
	if _, reason := readyReason(t, s); reason != "audit_replay_unavailable" {
		t.Fatalf("reason = %q", reason)
	}

	s = newGatewayTestServer(t)
	s.sts = nil
	if _, reason := readyReason(t, s); reason != "sts_unavailable" {
		t.Fatalf("reason = %q", reason)
	}

	s = newGatewayTestServer(t)
	if status, reason := readyReason(t, s); status != http.StatusServiceUnavailable || reason != "sts_unreachable" {
		t.Fatalf("status=%d reason=%q", status, reason)
	}
}

func TestHandleReadySucceedsWithHealthySTS(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer sts.Close()
	s := newGatewayTestServer(t)
	s.sts = newSTSClient(sts.URL, time.Second, nil)
	if status, reason := readyReason(t, s); status != http.StatusOK || reason != "" {
		t.Fatalf("status=%d reason=%q", status, reason)
	}
}

func TestMetricsAuthorization(t *testing.T) {
	s := newGatewayTestServer(t)
	if !s.metricsAuthorized(httptest.NewRequest(http.MethodGet, "/metrics", nil)) {
		t.Fatal("dev mode without bearer must allow metrics")
	}
	s.cfg.Mode = "stable"
	if s.metricsAuthorized(httptest.NewRequest(http.MethodGet, "/metrics", nil)) {
		t.Fatal("published mode without bearer must deny metrics")
	}
	s.cfg.MetricsBearer = "metrics-token"
	r := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	r.Header.Set("Authorization", "Bearer metrics-token")
	if !s.metricsAuthorized(r) {
		t.Fatal("matching bearer must allow metrics")
	}
	r.Header.Set("Authorization", "Bearer wrong-length")
	if s.metricsAuthorized(r) {
		t.Fatal("mismatched bearer must deny metrics")
	}
	r.Header.Set("Authorization", "Bearer metrics-tokeX")
	if s.metricsAuthorized(r) {
		t.Fatal("same-length wrong bearer must deny metrics")
	}
}

func TestHandleMetricsRendersGatewaySamples(t *testing.T) {
	s := newGatewayTestServer(t)
	w := httptest.NewRecorder()
	s.handleMetrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "caracal_gateway_requests_total") {
		t.Fatalf("metrics body missing gateway samples: %s", w.Body.String()[:120])
	}

	s.cfg.Mode = "stable"
	w = httptest.NewRecorder()
	s.handleMetrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized metrics status = %d", w.Code)
	}
}

func TestHandleMetricsJSONReturnsSnapshot(t *testing.T) {
	s := newGatewayTestServer(t)
	w := httptest.NewRecorder()
	s.handleMetricsJSON(w, httptest.NewRequest(http.MethodGet, "/metrics.json", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var snap map[string]any
	if err := json.NewDecoder(w.Body).Decode(&snap); err != nil {
		t.Fatalf("decode metrics json: %v", err)
	}

	s.cfg.Mode = "stable"
	w = httptest.NewRecorder()
	s.handleMetricsJSON(w, httptest.NewRequest(http.MethodGet, "/metrics.json", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized metrics.json status = %d", w.Code)
	}
}

func TestRefreshMetricGaugesTracksSnapshotFreshness(t *testing.T) {
	s := newGatewayTestServer(t)
	s.refreshMetricGauges()
	if s.metrics.Snapshot().RevocationSnapshotFresh != 1 {
		t.Fatal("fresh snapshot must report gauge 1")
	}

	s.revocations.markSnapshotFresh(time.Now().Add(-2 * snapshotStaleAfter))
	s.refreshMetricGauges()
	if s.metrics.Snapshot().RevocationSnapshotFresh != 0 {
		t.Fatal("stale snapshot must report gauge 0")
	}

	s.revocations = newRevocationStore(zerolog.Nop())
	s.audit = nil
	s.refreshMetricGauges()
	snap := s.metrics.Snapshot()
	if snap.RevocationSnapshotFresh != 0 || snap.RevocationSnapshotAgeSeconds != 0 {
		t.Fatalf("missing snapshot must zero freshness gauges: %+v", snap)
	}
}

func TestHandleRevocationReloadRequiresAdminAndPostgres(t *testing.T) {
	s := newGatewayTestServer(t)
	w := httptest.NewRecorder()
	s.handleRevocationReload(w, httptest.NewRequest(http.MethodPost, "/internal/revocations/reload", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unauthenticated reload status = %d", w.Code)
	}

	s.cfg.AdminToken = "admin-token"
	r := httptest.NewRequest(http.MethodPost, "/internal/revocations/reload", nil)
	r.Header.Set("Authorization", "Bearer admin-token")
	w = httptest.NewRecorder()
	s.handleRevocationReload(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("reload without postgres status = %d", w.Code)
	}
	if s.metrics.Snapshot().RevocationReloadErrors != 1 {
		t.Fatalf("reload errors = %d", s.metrics.Snapshot().RevocationReloadErrors)
	}

	r.Header.Set("Authorization", "Bearer wrong-size-token")
	if s.adminAuthorized(r) {
		t.Fatal("length mismatch must fail admin auth")
	}
}

func TestGatewayRunListensAndShutsDown(t *testing.T) {
	s := newGatewayTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	time.Sleep(150 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not shut down")
	}
}

func TestGatewayRunSurfacesListenFailure(t *testing.T) {
	s := newGatewayTestServer(t)
	s.cfg.Port = "notaport"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Run with invalid port must fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not report listen failure")
	}
}

func TestGatewayNewRequiresEnvironment(t *testing.T) {
	for _, key := range []string{"STS_URL", "DATABASE_URL", "REDIS_URL", "STREAMS_HMAC_KEY"} {
		t.Setenv(key, "")
	}
	if _, err := New(context.Background()); err == nil {
		t.Fatal("New without required env must fail")
	}
}

func setGatewayEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CARACAL_MODE", "dev")
	t.Setenv("STS_URL", "http://127.0.0.1:1")
	t.Setenv("DATABASE_URL", "postgres://caracal@127.0.0.1:1/caracal")
	t.Setenv("REDIS_URL", "redis://127.0.0.1:1/0")
	t.Setenv("STREAMS_HMAC_KEY", strings.Repeat("ab", 32))
	t.Setenv("AUDIT_REPLAY_DIR", t.TempDir())
	t.Setenv("PORT", "8081")
}

func TestGatewayNewFailsWithoutPostgres(t *testing.T) {
	setGatewayEnv(t)
	if _, err := New(context.Background()); err == nil {
		t.Fatal("New must fail when the binding reload cannot reach Postgres")
	}
}

func TestGatewayNewRejectsInvalidRedisURL(t *testing.T) {
	setGatewayEnv(t)
	t.Setenv("REDIS_URL", "http://not-redis")
	if _, err := New(context.Background()); err == nil {
		t.Fatal("New must reject a non-redis URL")
	}
}

func TestGatewayNewRejectsInvalidStreamKey(t *testing.T) {
	setGatewayEnv(t)
	t.Setenv("STREAMS_HMAC_KEY", "zz")
	if _, err := New(context.Background()); err == nil {
		t.Fatal("New must reject a malformed stream key")
	}
}
