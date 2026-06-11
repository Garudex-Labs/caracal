// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway JWKS cache, readiness, authorization, and metrics handler path tests.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/audit"
	"github.com/rs/zerolog"
)

func TestJWKSCacheVerifiesES256TokenAndCachesKeys(t *testing.T) {
	key := mustP256Key(t)
	token := signedES256(t, key, "kid-1")
	fetches := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches++
		if r.URL.Path != "/.well-known/jwks.json" || r.URL.Query().Get("zone_id") != "zone-1" {
			t.Fatalf("unexpected JWKS request %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []json.RawMessage{jwkForKey(t, &key.PublicKey, "kid-1")}})
	}))
	defer srv.Close()

	cache := newJWKSCache(srv.URL, time.Second, zerolog.Nop())
	if err := cache.Verify(context.Background(), "zone-1", token); err != nil {
		t.Fatalf("first verify: %v", err)
	}
	if err := cache.Verify(context.Background(), "zone-1", token); err != nil {
		t.Fatalf("cached verify: %v", err)
	}
	if fetches != 1 {
		t.Fatalf("want one JWKS fetch, got %d", fetches)
	}
}

func TestJWKSCacheRejectsMalformedAndUnsupportedTokens(t *testing.T) {
	cache := newJWKSCache("http://127.0.0.1:1", time.Millisecond, zerolog.Nop())
	for _, token := range []string{
		"not-a-jws",
		base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"kid"}`)) + ".e30.sig",
		base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"ES256"}`)) + ".e30.sig",
	} {
		if err := cache.Verify(context.Background(), "zone-1", token); err == nil {
			t.Fatalf("token %q should fail", token)
		}
	}
}

func TestJWKSCacheRateLimitsForcedMissRefresh(t *testing.T) {
	key := mustP256Key(t)
	missingKidToken := signedES256(t, key, "kid-missing")
	fetches := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches++
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []json.RawMessage{jwkForKey(t, &key.PublicKey, "kid-present")}})
	}))
	defer srv.Close()

	cache := newJWKSCache(srv.URL, time.Second, zerolog.Nop())
	if err := cache.Verify(context.Background(), "zone-1", missingKidToken); err == nil {
		t.Fatal("missing kid should fail")
	}
	if err := cache.Verify(context.Background(), "zone-1", missingKidToken); err == nil {
		t.Fatal("cached miss cooldown should fail")
	}
	if fetches != 2 {
		t.Fatalf("second miss should be cooldown-only, got %d fetches", fetches)
	}
}

func TestJWKSFetchRejectsBadStatusAndUnusableKeys(t *testing.T) {
	statusServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusBadGateway)
	}))
	defer statusServer.Close()
	if _, err := newJWKSCache(statusServer.URL, time.Second, zerolog.Nop()).fetch(context.Background(), "zone-1"); err == nil {
		t.Fatal("bad status should fail")
	}

	emptyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{"alg": "RS256"}}})
	}))
	defer emptyServer.Close()
	if _, err := newJWKSCache(emptyServer.URL, time.Second, zerolog.Nop()).fetch(context.Background(), "zone-1"); err == nil {
		t.Fatal("JWKS without ES256 keys should fail")
	}
}

func TestGatewayReadyReportsSuccessAndDependencyFailures(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer sts.Close()
	server := testGatewayServer(t, sts.URL)

	w := httptest.NewRecorder()
	server.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("ready status = %d body=%s", w.Code, w.Body.String())
	}

	server.redis = &readyRedis{pingErr: errors.New("redis down"), fakeRevocationRedis: fakeRevocationRedis{verify: true}}
	w = httptest.NewRecorder()
	server.handleReady(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "redis_unreachable") {
		t.Fatalf("redis failure status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestGatewayMetricsAuthorizationAndJSONGauges(t *testing.T) {
	server := testGatewayServer(t, "http://127.0.0.1:1")
	server.cfg.MetricsBearer = "secret"
	server.revocations.markSession("sid-1")
	server.revocations.markSnapshotFresh(time.Now().Add(-time.Second))

	w := httptest.NewRecorder()
	server.handleMetricsJSON(w, httptest.NewRequest(http.MethodGet, "/metrics.json", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized metrics status = %d", w.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/metrics.json", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	server.handleMetricsJSON(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("authorized metrics status = %d body=%s", w.Code, w.Body.String())
	}
	var snap GatewayMetricsSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &snap); err != nil {
		t.Fatal(err)
	}
	if snap.BindingsLoaded != 1 || snap.RevocationsActive != 1 || snap.RevocationSnapshotFresh != 1 {
		t.Fatalf("unexpected metric gauges: %+v", snap)
	}

	textReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	textReq.Header.Set("Authorization", "Bearer secret")
	textW := httptest.NewRecorder()
	server.handleMetrics(textW, textReq)
	if textW.Code != http.StatusOK || !strings.Contains(textW.Body.String(), "caracal_gateway_revocations_active") {
		t.Fatalf("unexpected text metrics status=%d body=%s", textW.Code, textW.Body.String())
	}
}

func TestGatewayAdminAuthorizationUsesBearerToken(t *testing.T) {
	server := &Server{cfg: Config{AdminToken: "admin"}}
	if server.adminAuthorized(httptest.NewRequest(http.MethodPost, "/", nil)) {
		t.Fatal("missing admin bearer must fail")
	}
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Authorization", "Bearer admin")
	if !server.adminAuthorized(req) {
		t.Fatal("matching admin bearer must pass")
	}
}

func TestGatewayRevocationReloadAuthorizationAndFailure(t *testing.T) {
	server := testGatewayServer(t, "http://127.0.0.1:1")
	server.cfg.AdminToken = "admin"

	w := httptest.NewRecorder()
	server.handleRevocationReload(w, httptest.NewRequest(http.MethodPost, "/internal/revocations/reload", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unauthorized reload status = %d", w.Code)
	}

	req := httptest.NewRequest(http.MethodPost, "/internal/revocations/reload", nil)
	req.Header.Set("Authorization", "Bearer admin")
	w = httptest.NewRecorder()
	server.handleRevocationReload(w, req)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "revocation_reload_failed") {
		t.Fatalf("reload failure status=%d body=%s", w.Code, w.Body.String())
	}
	if server.metrics.Snapshot().RevocationReloadErrors != 1 {
		t.Fatalf("reload error metric = %d", server.metrics.Snapshot().RevocationReloadErrors)
	}
}

type readyRedis struct {
	fakeRevocationRedis
	pingErr error
}

func (r *readyRedis) Ping(context.Context) error { return r.pingErr }

type fakeAuditStream struct{}

func (fakeAuditStream) XAdd(context.Context, string, map[string]any) error { return nil }

func testGatewayServer(t *testing.T, stsURL string) *Server {
	t.Helper()
	bindings := newTestBindingStore(&fakeBindingPool{
		t: t,
		queries: []bindingQuery{
			{sql: "SELECT version FROM gateway_binding_revision WHERE id = true", rows: rowValues([]any{int64(1)})},
			{sql: "SELECT version FROM gateway_binding_revision WHERE id = true", rows: rowValues([]any{int64(1)})},
		},
	})
	cached := map[string]binding{"zone-1\x00resource://api": {ZoneID: "zone-1", ApplicationID: "app-1"}}
	bindings.cache.Store(&cached)
	bindings.revision.Store(1)
	auditClient, err := audit.NewClient(fakeAuditStream{}, audit.ClientConfig{ReplayDir: t.TempDir(), Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	revocations := newRevocationStore(zerolog.Nop())
	revocations.markSnapshotFresh(time.Now())
	return &Server{
		cfg:         Config{},
		log:         zerolog.Nop(),
		sts:         newSTSClient(stsURL, time.Second, nil),
		bindings:    bindings,
		redis:       &readyRedis{fakeRevocationRedis: fakeRevocationRedis{verify: true}},
		audit:       auditClient,
		revocations: revocations,
		metrics:     &GatewayMetrics{},
	}
}

func mustP256Key(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func signedES256(t *testing.T, key *ecdsa.PrivateKey, kid string) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"ES256","kid":"` + kid + `"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"user-1"}`))
	digest := sha256.Sum256([]byte(header + "." + payload))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := append(pad32(r), pad32(s)...)
	return header + "." + payload + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func jwkForKey(t *testing.T, key *ecdsa.PublicKey, kid string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"kty": "EC",
		"crv": "P-256",
		"alg": "ES256",
		"use": "sig",
		"kid": kid,
		"x":   base64.RawURLEncoding.EncodeToString(pad32(key.X)),
		"y":   base64.RawURLEncoding.EncodeToString(pad32(key.Y)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func pad32(n *big.Int) []byte {
	out := make([]byte, 32)
	raw := n.Bytes()
	copy(out[32-len(raw):], raw)
	return out
}

var _ gatewayRedis = (*readyRedis)(nil)
var _ audit.Streamer = fakeAuditStream{}

func TestGatewayMetricsFailClosedWithoutBearerInPublishedMode(t *testing.T) {
	server := &Server{cfg: Config{Mode: "stable"}}
	w := httptest.NewRecorder()
	server.handleMetrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("published gateway metrics without bearer must be 401, got %d", w.Code)
	}
	w = httptest.NewRecorder()
	server.handleMetricsJSON(w, httptest.NewRequest(http.MethodGet, "/metrics.json", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("published gateway metrics.json without bearer must be 401, got %d", w.Code)
	}
}
