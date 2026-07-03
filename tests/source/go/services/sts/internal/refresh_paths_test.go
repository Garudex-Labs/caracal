// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Brokered credential refresh path tests: coordination, circuit breaker, and OAuth request construction.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

// memSTSRedis is a stateful in-memory stsRedis for coordination and circuit tests.
type memSTSRedis struct {
	mu        sync.Mutex
	values    map[string]string
	counters  map[string]int64
	setNXErr  error
	getErr    error
	setTTLErr error
	incrErr   error
}

func newMemSTSRedis() *memSTSRedis {
	return &memSTSRedis{values: map[string]string{}, counters: map[string]int64{}}
}

func (m *memSTSRedis) Ping(context.Context) error                     { return nil }
func (m *memSTSRedis) EvictionPolicy(context.Context) (string, error) { return "noeviction", nil }

func (m *memSTSRedis) SetNXTTL(_ context.Context, key, value string, _ time.Duration) (bool, error) {
	if m.setNXErr != nil {
		return false, m.setNXErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.values[key]; ok {
		return false, nil
	}
	m.values[key] = value
	return true, nil
}

func (m *memSTSRedis) SetTTL(_ context.Context, key string, value any, _ time.Duration) error {
	if m.setTTLErr != nil {
		return m.setTTLErr
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.values[key] = string(data)
	m.mu.Unlock()
	return nil
}

func (m *memSTSRedis) Get(_ context.Context, key string) (string, error) {
	if m.getErr != nil {
		return "", m.getErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.values[key]
	if !ok {
		return "", redis.Nil
	}
	return value, nil
}

func (m *memSTSRedis) Del(_ context.Context, key string) error {
	m.mu.Lock()
	delete(m.values, key)
	m.mu.Unlock()
	return nil
}

func (m *memSTSRedis) DelIfValue(_ context.Context, key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.values[key] == value {
		delete(m.values, key)
	}
	return nil
}

func (m *memSTSRedis) ExpireIfValue(_ context.Context, key, value string, _ time.Duration) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.values[key] == value, nil
}

func (m *memSTSRedis) Exists(_ context.Context, key string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.values[key]
	return ok, nil
}

func (m *memSTSRedis) IncrWithExpiry(_ context.Context, key string, _ time.Duration) (int64, error) {
	if m.incrErr != nil {
		return 0, m.incrErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counters[key]++
	return m.counters[key], nil
}

func (m *memSTSRedis) EnsureGroup(context.Context, string, string) error { return nil }

func (m *memSTSRedis) XReadGroup(ctx context.Context, _, _, _ string, _ int64) ([]redis.XMessage, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (m *memSTSRedis) XAutoClaim(context.Context, string, string, string, string, time.Duration, int64) ([]redis.XMessage, string, error) {
	return nil, "0-0", nil
}

func (m *memSTSRedis) VerifyStream(string, map[string]any) bool           { return true }
func (m *memSTSRedis) XAck(context.Context, string, string, string) error { return nil }
func (m *memSTSRedis) SignedXAdd(context.Context, string, map[string]any) error {
	return nil
}

func (m *memSTSRedis) set(key, value string) {
	m.mu.Lock()
	m.values[key] = value
	m.mu.Unlock()
}

func (m *memSTSRedis) has(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.values[key]
	return ok
}

func refreshTestServer(db DBQuerier, r stsRedis) *Server {
	zek := make([]byte, 32)
	for i := range zek {
		zek[i] = byte(i + 1)
	}
	return &Server{
		db:      db,
		redis:   r,
		keys:    newKeyCache(db, zek),
		metrics: &STSMetrics{},
		cfg:     Config{MaxGrantTTLSeconds: 3600},
		log:     zerolog.Nop(),
	}
}

func TestOpenZEKRejectsTamperedCiphertext(t *testing.T) {
	zek := make([]byte, 32)
	packed, err := sealZEK(zek, []byte("refresh-token"))
	if err != nil {
		t.Fatal(err)
	}
	packed[len(packed)-1] ^= 0xff
	if _, err := openZEK(zek, packed); err == nil {
		t.Fatal("tampered ciphertext must fail to open")
	}
	if _, err := openZEK(zek, []byte("short")); err == nil {
		t.Fatal("truncated ciphertext must fail to open")
	}
	if _, err := sealZEK([]byte("bad-key"), []byte("x")); err == nil {
		t.Fatal("invalid key length must fail to seal")
	}
}

func TestRefreshGrantKeyPrefersGrantID(t *testing.T) {
	if got := refreshGrantKey("z", "u", "r", nil, &ProviderGrant{ID: "grant-1"}); got != "grant\x00grant-1" {
		t.Fatalf("grant id key = %q", got)
	}
	providerID := "provider-1"
	if got := refreshGrantKey("z", "u", "r", &providerID, nil); got != "z\x00u\x00r\x00provider-1" {
		t.Fatalf("composite key = %q", got)
	}
	if got := refreshGrantKey("z", "u", "r", nil, &ProviderGrant{}); got != "z\x00u\x00r\x00" {
		t.Fatalf("composite key without provider = %q", got)
	}
}

func TestNormalizeOAuthClientAuthMethod(t *testing.T) {
	cases := map[string]string{
		"client_secret_post": "client_secret_post",
		"private_key_jwt":    "private_key_jwt",
		"none":               "none",
		"":                   "client_secret_basic",
		"unknown":            "client_secret_basic",
	}
	for input, want := range cases {
		if got := normalizeOAuthClientAuthMethod(input); got != want {
			t.Errorf("normalizeOAuthClientAuthMethod(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestApplyOAuthTokenParamsGuardsReservedNames(t *testing.T) {
	form := url.Values{}
	if err := applyOAuthTokenParams(form, map[string]string{"audience": "resource://nucleus"}); err != nil {
		t.Fatal(err)
	}
	if form.Get("audience") != "resource://nucleus" {
		t.Fatalf("param not applied: %v", form)
	}
	if err := applyOAuthTokenParams(form, map[string]string{"": "x"}); err == nil {
		t.Fatal("empty name must be rejected")
	}
	if err := applyOAuthTokenParams(form, map[string]string{"audience": " "}); err == nil {
		t.Fatal("empty value must be rejected")
	}
	if err := applyOAuthTokenParams(form, map[string]string{"refresh_token": "stolen"}); err == nil {
		t.Fatal("reserved param must be rejected")
	}
}

func ecKeyPEM(t *testing.T, curve elliptic.Curve) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
}

func TestProviderSigningKeyVariants(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8RSA, err := x509.MarshalPKCS8PrivateKey(rsaKey)
	if err != nil {
		t.Fatal(err)
	}
	ecKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8EC, err := x509.MarshalPKCS8PrivateKey(ecKey)
	if err != nil {
		t.Fatal(err)
	}
	_, edKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8Ed, err := x509.MarshalPKCS8PrivateKey(edKey)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		pemText string
		alg     string
	}{
		"pkcs8 rsa": {string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8RSA})), "RS256"},
		"pkcs1 rsa": {string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rsaKey)})), "RS256"},
		"pkcs8 ec":  {string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8EC})), "ES384"},
		"sec1 p256": {ecKeyPEM(t, elliptic.P256()), "ES256"},
		"sec1 p521": {ecKeyPEM(t, elliptic.P521()), "ES512"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			method, key, err := providerSigningKey(tc.pemText)
			if err != nil || key == nil {
				t.Fatalf("signing key parse failed: %v", err)
			}
			if method.Alg() != tc.alg {
				t.Fatalf("alg = %q, want %q", method.Alg(), tc.alg)
			}
		})
	}
	if _, _, err := providerSigningKey("not pem"); err == nil {
		t.Fatal("non-PEM key must be rejected")
	}
	if _, _, err := providerSigningKey(string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8Ed}))); err == nil {
		t.Fatal("ed25519 keys must be rejected as unsupported")
	}
}

func TestBuildProviderTokenRequestAuthMethods(t *testing.T) {
	endpoint := &url.URL{Scheme: "https", Host: "login.hooli.example", Path: "/oauth/token"}
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {"rt-1"}}

	readForm := func(t *testing.T, req *http.Request) url.Values {
		t.Helper()
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		values, err := url.ParseQuery(string(body))
		if err != nil {
			t.Fatal(err)
		}
		return values
	}

	basic, err := buildProviderTokenRequest(context.Background(), endpoint, form, "client-1", "secret-1", "client_secret_basic", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if user, pass, ok := basic.BasicAuth(); !ok || user != "client-1" || pass != "secret-1" {
		t.Fatal("client_secret_basic must set basic auth")
	}
	if values := readForm(t, basic); values.Get("client_secret") != "" || values.Get("refresh_token") != "rt-1" {
		t.Fatalf("basic auth body must not carry the secret: %v", values)
	}

	post, err := buildProviderTokenRequest(context.Background(), endpoint, form, "client-1", "secret-1", "client_secret_post", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if values := readForm(t, post); values.Get("client_id") != "client-1" || values.Get("client_secret") != "secret-1" {
		t.Fatalf("client_secret_post must carry credentials in the form: %v", values)
	}

	public, err := buildProviderTokenRequest(context.Background(), endpoint, form, "client-1", "", "none", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if values := readForm(t, public); values.Get("client_id") != "client-1" || values.Get("client_secret") != "" {
		t.Fatalf("public client must carry only client_id: %v", values)
	}

	jwtReq, err := buildProviderTokenRequest(context.Background(), endpoint, form, "client-1", "", "private_key_jwt", "kid-1", ecKeyPEM(t, elliptic.P256()))
	if err != nil {
		t.Fatal(err)
	}
	values := readForm(t, jwtReq)
	if values.Get("client_assertion_type") != "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" {
		t.Fatalf("assertion type missing: %v", values)
	}
	assertion := values.Get("client_assertion")
	parsed, _, err := jwt.NewParser().ParseUnverified(assertion, jwt.MapClaims{})
	if err != nil {
		t.Fatalf("client assertion must parse: %v", err)
	}
	claims := parsed.Claims.(jwt.MapClaims)
	if claims["iss"] != "client-1" || claims["sub"] != "client-1" || claims["aud"] != endpoint.String() {
		t.Fatalf("assertion claims wrong: %#v", claims)
	}
	if parsed.Header["kid"] != "kid-1" {
		t.Fatalf("assertion must carry key id header: %#v", parsed.Header)
	}

	if _, err := buildProviderTokenRequest(context.Background(), endpoint, form, "client-1", "", "private_key_jwt", "", "not pem"); err == nil {
		t.Fatal("bad signing key must fail request construction")
	}
}

func TestReadRefreshResultStates(t *testing.T) {
	r := newMemSTSRedis()
	server := refreshTestServer(&stubDB{}, r)

	if _, ok, err := server.readRefreshResult(context.Background(), "missing"); ok || err != nil {
		t.Fatalf("missing key must report absent, ok=%v err=%v", ok, err)
	}

	r.set("bad", "{not json")
	if _, _, err := server.readRefreshResult(context.Background(), "bad"); err == nil {
		t.Fatal("malformed result must error")
	}

	r.set("ok", `{"ok":true}`)
	if res, ok, err := server.readRefreshResult(context.Background(), "ok"); !ok || err != nil || res != nil {
		t.Fatalf("success result must yield nil error, res=%v ok=%v err=%v", res, ok, err)
	}

	r.set("coded", `{"ok":false,"code":"credential_expired_not_renewable","description":"boom"}`)
	res, ok, err := server.readRefreshResult(context.Background(), "coded")
	if !ok || err != nil || res == nil || res.Code != sharederr.CredentialExpired {
		t.Fatalf("coded failure must propagate, res=%#v ok=%v err=%v", res, ok, err)
	}

	r.set("blank", `{"ok":false}`)
	if res, ok, _ := server.readRefreshResult(context.Background(), "blank"); !ok || res == nil || res.Code != sharederr.Internal {
		t.Fatalf("blank failure must map to internal, res=%#v", res)
	}

	r.getErr = errors.New("redis down")
	if _, _, err := server.readRefreshResult(context.Background(), "ok"); err == nil {
		t.Fatal("redis failure must propagate")
	}
}

func TestProviderCircuitBreakerOpensAfterRepeatedFailures(t *testing.T) {
	r := newMemSTSRedis()
	server := refreshTestServer(&stubDB{}, r)

	if server.providerCircuitOpen(context.Background(), "provider-1") {
		t.Fatal("circuit must start closed")
	}
	for range providerFailureLimit {
		server.recordProviderFailure(context.Background(), "provider-1")
	}
	if !server.providerCircuitOpen(context.Background(), "provider-1") {
		t.Fatal("circuit must open after the failure limit")
	}
	if server.metrics.Snapshot().ProviderCircuitOpen == 0 {
		t.Fatal("open circuit must increment the metric")
	}
	server.clearProviderFailures(context.Background(), "provider-1")
	if server.providerCircuitOpen(context.Background(), "provider-1") {
		t.Fatal("clearing failures must close the circuit")
	}

	nilRedis := refreshTestServer(&stubDB{}, nil)
	if nilRedis.providerCircuitOpen(context.Background(), "provider-1") {
		t.Fatal("no redis means the circuit never opens")
	}
	nilRedis.recordProviderFailure(context.Background(), "provider-1")
	nilRedis.clearProviderFailures(context.Background(), "provider-1")
}

func TestCoordinatedDistributedRefreshLeaderPublishesResult(t *testing.T) {
	r := newMemSTSRedis()
	server := refreshTestServer(&stubDB{}, r)
	lockKey, resultKey := refreshCoordinationKeys("grant-1")

	called := 0
	err := server.coordinatedDistributedGrantRefresh(context.Background(), "grant-1", func(context.Context) *sharederr.CaracalError {
		called++
		return nil
	})
	if err != nil || called != 1 {
		t.Fatalf("leader must run the refresh once, err=%v called=%d", err, called)
	}
	if !r.has(resultKey) {
		t.Fatal("leader must publish its result for waiting peers")
	}
	if r.has(lockKey) {
		t.Fatal("leader must release its lease")
	}
	if server.metrics.Snapshot().ProviderRefreshLeased != 1 {
		t.Fatal("lease metric must record the acquisition")
	}
}

func TestCoordinatedDistributedRefreshUsesPeerResult(t *testing.T) {
	r := newMemSTSRedis()
	server := refreshTestServer(&stubDB{}, r)
	_, resultKey := refreshCoordinationKeys("grant-1")
	r.set(resultKey, `{"ok":false,"code":"credential_expired_not_renewable","description":"peer says no"}`)

	err := server.coordinatedDistributedGrantRefresh(context.Background(), "grant-1", func(context.Context) *sharederr.CaracalError {
		t.Fatal("peer result present: refresh must not run")
		return nil
	})
	if err == nil || err.Code != sharederr.CredentialExpired {
		t.Fatalf("peer failure must propagate, got %#v", err)
	}
	if server.metrics.Snapshot().ProviderRefreshWaited != 1 {
		t.Fatal("waited metric must record the peer result")
	}
}

func TestCoordinatedDistributedRefreshWaitsForContendedLease(t *testing.T) {
	r := newMemSTSRedis()
	server := refreshTestServer(&stubDB{}, r)
	lockKey, resultKey := refreshCoordinationKeys("grant-1")
	r.set(lockKey, "peer-lease")

	go func() {
		time.Sleep(30 * time.Millisecond)
		r.set(resultKey, `{"ok":true}`)
	}()

	err := server.coordinatedDistributedGrantRefresh(context.Background(), "grant-1", func(context.Context) *sharederr.CaracalError {
		t.Error("waiter must never run the refresh itself")
		return nil
	})
	if err != nil {
		t.Fatalf("waiter must adopt the peer's success, got %#v", err)
	}
}

func TestCoordinatedDistributedRefreshCoordinationFailures(t *testing.T) {
	r := newMemSTSRedis()
	r.setNXErr = errors.New("redis down")
	server := refreshTestServer(&stubDB{}, r)
	err := server.coordinatedDistributedGrantRefresh(context.Background(), "grant-1", func(context.Context) *sharederr.CaracalError { return nil })
	if err == nil || err.Code != sharederr.STSUnavailable {
		t.Fatalf("lock failure must surface as unavailable, got %#v", err)
	}

	direct := refreshTestServer(&stubDB{}, nil)
	called := 0
	if err := direct.coordinatedDistributedGrantRefresh(context.Background(), "grant-1", func(context.Context) *sharederr.CaracalError {
		called++
		return nil
	}); err != nil || called != 1 {
		t.Fatalf("no redis must refresh directly, err=%v called=%d", err, called)
	}
}

func TestRefreshProviderTokenValidatesClientConfiguration(t *testing.T) {
	server := refreshTestServer(&stubDB{}, newMemSTSRedis())
	endpoint := &url.URL{Scheme: "https", Host: "login.hooli.example", Path: "/oauth/token"}
	form := url.Values{"grant_type": {"refresh_token"}}

	if _, err := server.refreshProviderToken(context.Background(), "p1", endpoint, form, "", "secret", "client_secret_basic", "", ""); err == nil {
		t.Fatal("missing client_id must fail")
	}
	if _, err := server.refreshProviderToken(context.Background(), "p1", endpoint, form, "client-1", "", "private_key_jwt", "", ""); err == nil {
		t.Fatal("missing private key must fail")
	}
	if _, err := server.refreshProviderToken(context.Background(), "p1", endpoint, form, "client-1", "", "client_secret_basic", "", ""); err == nil {
		t.Fatal("missing client secret must fail")
	}
}

func TestRefreshProviderTokenRecordsFailureOnBlockedEndpoint(t *testing.T) {
	r := newMemSTSRedis()
	server := refreshTestServer(&stubDB{}, r)
	endpoint := &url.URL{Scheme: "https", Host: "localhost:1", Path: "/oauth/token"}
	form := url.Values{"grant_type": {"refresh_token"}}

	if _, err := server.refreshProviderToken(context.Background(), "p1", endpoint, form, "client-1", "secret", "client_secret_basic", "", ""); err == nil {
		t.Fatal("loopback endpoint must be blocked by the SSRF dialer")
	}
	r.mu.Lock()
	failures := r.counters["provider-refresh-failures:p1"]
	r.mu.Unlock()
	if failures != 1 {
		t.Fatalf("failed refresh must record one provider failure, got %d", failures)
	}
}

// refreshDB overrides grant persistence behavior on top of the shared stub.
type refreshDB struct {
	stubDB
	updateErrs []error
	updates    int
	latest     *ProviderGrant
}

func (d *refreshDB) UpdateProviderGrantTokens(_ context.Context, _ string, _ int, _, _ []byte, _ time.Time) error {
	d.updates++
	if len(d.updateErrs) == 0 {
		return nil
	}
	err := d.updateErrs[0]
	d.updateErrs = d.updateErrs[1:]
	return err
}

func (d *refreshDB) GetProviderGrant(_ context.Context, _, _, _ string, _ *string) (*ProviderGrant, error) {
	if d.latest == nil {
		return nil, errors.New("no grant")
	}
	return d.latest, nil
}

func TestPersistRefreshedGrantPaths(t *testing.T) {
	grant := &ProviderGrant{ID: "grant-1", RefreshTokenVersion: 1}
	expiresAt := time.Now().Add(time.Hour)

	t.Run("first write succeeds", func(t *testing.T) {
		db := &refreshDB{}
		server := refreshTestServer(db, nil)
		if err := server.persistRefreshedGrant(context.Background(), "z", "u", "r", grant, []byte("a"), []byte("b"), expiresAt); err != nil {
			t.Fatal(err)
		}
		if db.updates != 1 {
			t.Fatalf("expected one update, got %d", db.updates)
		}
	})

	t.Run("non-conflict error propagates", func(t *testing.T) {
		db := &refreshDB{updateErrs: []error{errors.New("pg down")}}
		server := refreshTestServer(db, nil)
		if err := server.persistRefreshedGrant(context.Background(), "z", "u", "r", grant, nil, nil, expiresAt); err == nil {
			t.Fatal("database failure must propagate")
		}
	})

	t.Run("conflict with fresh peer short-circuits", func(t *testing.T) {
		future := time.Now().Add(30 * time.Minute)
		db := &refreshDB{
			updateErrs: []error{ErrConcurrentGrantUpdate},
			latest:     &ProviderGrant{ID: "grant-1", RefreshTokenVersion: 2, ExpiresAt: &future},
		}
		server := refreshTestServer(db, nil)
		if err := server.persistRefreshedGrant(context.Background(), "z", "u", "r", grant, nil, nil, expiresAt); err != nil {
			t.Fatalf("peer-refreshed grant must succeed silently, got %v", err)
		}
		if db.updates != 1 {
			t.Fatalf("must not rewrite over a fresher peer, updates=%d", db.updates)
		}
	})

	t.Run("persistent conflict exhausts retries", func(t *testing.T) {
		past := time.Now().Add(-time.Minute)
		db := &refreshDB{
			updateErrs: []error{ErrConcurrentGrantUpdate, ErrConcurrentGrantUpdate, ErrConcurrentGrantUpdate},
			latest:     &ProviderGrant{ID: "grant-1", RefreshTokenVersion: 2, ExpiresAt: &past},
		}
		server := refreshTestServer(db, nil)
		if err := server.persistRefreshedGrant(context.Background(), "z", "u", "r", grant, nil, nil, expiresAt); !errors.Is(err, ErrConcurrentGrantUpdate) {
			t.Fatalf("exhausted retries must surface the conflict, got %v", err)
		}
	})
}

// grantDB serves scripted grant and provider rows for refresh deny-path tests.
type grantDB struct {
	stubDB
	grant       *ProviderGrant
	grantErr    error
	providerRow *ProviderConfig
	providerErr error
}

func (d *grantDB) GetProviderGrant(_ context.Context, _, _, _ string, _ *string) (*ProviderGrant, error) {
	return d.grant, d.grantErr
}

func (d *grantDB) GetProvider(_ context.Context, _ string) (*ProviderConfig, error) {
	return d.providerRow, d.providerErr
}

func expiredGrant(refreshCt []byte, providerID *string) *ProviderGrant {
	past := time.Now().Add(-time.Minute)
	return &ProviderGrant{ID: "grant-1", ProviderID: providerID, RefreshTokenCt: refreshCt, ExpiresAt: &past}
}

func TestTryRefreshBrokeredGrantSkipPaths(t *testing.T) {
	providerID := "provider-1"

	server := refreshTestServer(&grantDB{grantErr: errors.New("no grant")}, nil)
	if err := server.tryRefreshBrokeredGrant(context.Background(), "z", "", "r", nil); err != nil {
		t.Fatalf("empty user must be a no-op, got %v", err)
	}
	if err := server.tryRefreshBrokeredGrant(context.Background(), "z", "user-1", "r", nil); err != nil {
		t.Fatalf("missing grant must be a no-op, got %v", err)
	}

	future := time.Now().Add(time.Hour)
	fresh := refreshTestServer(&grantDB{grant: &ProviderGrant{ID: "grant-1", ExpiresAt: &future}}, nil)
	if err := fresh.tryRefreshBrokeredGrant(context.Background(), "z", "user-1", "r", nil); err != nil {
		t.Fatalf("fresh grant must be a no-op, got %v", err)
	}

	dead := refreshTestServer(&grantDB{grant: expiredGrant(nil, &providerID)}, nil)
	err := dead.tryRefreshBrokeredGrant(context.Background(), "z", "user-1", "r", nil)
	if err == nil || err.Code != sharederr.CredentialExpired {
		t.Fatalf("grant without refresh token must be expired, got %#v", err)
	}
}

func TestRefreshExpiredBrokeredGrantDenyMatrix(t *testing.T) {
	providerID := "provider-1"
	zek := make([]byte, 32)
	for i := range zek {
		zek[i] = byte(i + 1)
	}
	sealedRefresh, err := sealZEK(zek, []byte("refresh-token"))
	if err != nil {
		t.Fatal(err)
	}

	run := func(db DBQuerier) *sharederr.CaracalError {
		server := refreshTestServer(db, nil)
		return server.refreshExpiredBrokeredGrant(context.Background(), "z", "user-1", "r", &providerID)
	}

	cases := map[string]struct {
		db          *grantDB
		description string
	}{
		"provider lookup fails": {
			db:          &grantDB{grant: expiredGrant(sealedRefresh, &providerID), providerErr: errors.New("gone")},
			description: "credential_expired_not_renewable",
		},
		"wrong provider kind": {
			db: &grantDB{
				grant:       expiredGrant(sealedRefresh, &providerID),
				providerRow: &ProviderConfig{ID: providerID, ProviderKind: strPtr("api_key"), ConfigJSON: json.RawMessage(`{}`)},
			},
			description: "credential_expired_not_renewable",
		},
		"config missing endpoint": {
			db: &grantDB{
				grant:       expiredGrant(sealedRefresh, &providerID),
				providerRow: &ProviderConfig{ID: providerID, ProviderKind: strPtr("oauth2_authorization_code"), ConfigJSON: json.RawMessage(`{"client_id":"c1"}`)},
			},
			description: "credential_expired_not_renewable",
		},
		"secret decrypt fails": {
			db: &grantDB{
				grant: expiredGrant(sealedRefresh, &providerID),
				providerRow: &ProviderConfig{
					ID:                providerID,
					ProviderKind:      strPtr("oauth2_authorization_code"),
					ConfigJSON:        json.RawMessage(`{"token_endpoint":"https://login.hooli.example/token","client_id":"c1"}`),
					SecretConfigCt:    []byte("garbage"),
					SecretConfigNonce: make([]byte, 12),
				},
			},
			description: "credential_expired_not_renewable",
		},
		"endpoint not https": {
			db: &grantDB{
				grant: expiredGrant(sealedRefresh, &providerID),
				providerRow: &ProviderConfig{
					ID:           providerID,
					ProviderKind: strPtr("oauth2_authorization_code"),
					ConfigJSON:   json.RawMessage(`{"token_endpoint":"http://login.hooli.example/token","client_id":"c1","allowed_token_hosts":["login.hooli.example"]}`),
				},
			},
			description: "credential endpoint not allowed",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			err := run(tc.db)
			if err == nil || err.Code != sharederr.CredentialExpired {
				t.Fatalf("expected credential_expired, got %#v", err)
			}
			if !strings.Contains(err.Description, tc.description) {
				t.Fatalf("description = %q, want %q", err.Description, tc.description)
			}
		})
	}
}
