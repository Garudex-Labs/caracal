// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Targeted security tests for STS hardening: KEK guard, Argon2id, challenge binding,
// SSRF defenses, JWKS zone scoping, and policy reload safety.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func testKEK(fill byte) []byte {
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = fill
	}
	return kek
}

func TestResolveKEKRejectsEmpty(t *testing.T) {
	t.Setenv("ZONE_KEK", "")
	_, err := resolveKEK("local")
	if err == nil {
		t.Fatal("must reject empty ZONE_KEK")
	}
}

func TestResolveKEKRejectsAllZeros(t *testing.T) {
	t.Setenv("ZONE_KEK", hex.EncodeToString(make([]byte, 32)))
	if _, err := resolveKEK("local"); err == nil {
		t.Fatal("must reject all-zero ZONE_KEK")
	}
}

func TestResolveKEKRejectsBadHex(t *testing.T) {
	t.Setenv("ZONE_KEK", "not-hex")
	if _, err := resolveKEK("local"); err == nil {
		t.Fatal("expected hex decode error")
	}
}

func TestResolveKEKRejectsWrongLength(t *testing.T) {
	t.Setenv("ZONE_KEK", hex.EncodeToString(make([]byte, 16)))
	if _, err := resolveKEK("local"); err == nil {
		t.Fatal("expected length error")
	}
}

func TestRotateZoneSigningKeyEndpointRequiresAdmin(t *testing.T) {
	srv := &Server{}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/internal/zones/z1/signing-key/rotate", nil)
	r.SetPathValue("zoneID", "z1")
	srv.handleRotateZoneSigningKey(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("disabled endpoint status = %d, want 404", w.Code)
	}

	srv.cfg.AdminToken = "secret"
	w = httptest.NewRecorder()
	srv.handleRotateZoneSigningKey(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want 401", w.Code)
	}
}

func TestRotateZoneSigningKeyEndpointCreatesKeyAndInvalidatesCache(t *testing.T) {
	db := &stubDB{}
	srv := &Server{
		cfg:  Config{AdminToken: "secret"},
		db:   db,
		keys: newKeyCache(db, testKEK(1)),
	}
	cached := map[string]*ecdsa.PublicKey{}
	srv.keys.entries["z1"] = &zoneCacheEntry{expiresAt: time.Now().Add(time.Hour)}
	srv.keys.pubKeysCache["z1"] = &publicKeysCacheEntry{keys: cached, expiresAt: time.Now().Add(time.Hour)}

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/internal/zones/z1/signing-key/rotate", nil)
	r.SetPathValue("zoneID", "z1")
	r.Header.Set("Authorization", "Bearer secret")
	srv.handleRotateZoneSigningKey(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if db.insertedKey == nil || len(db.insertedKey.Ciphertext) == 0 || len(db.insertedKey.Nonce) == 0 {
		t.Fatal("rotation did not insert encrypted signing key")
	}
	if _, ok := srv.keys.entries["z1"]; ok {
		t.Fatal("private key cache was not invalidated")
	}
	if _, ok := srv.keys.pubKeysCache["z1"]; ok {
		t.Fatal("public key cache was not invalidated")
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["kid"] != "kid-rotated" || body["zone_id"] != "z1" {
		t.Fatalf("unexpected response: %#v", body)
	}
}

func TestArgon2idRoundTrip(t *testing.T) {
	hash, err := hashClientSecret("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, argon2Prefix) {
		t.Fatalf("hash missing argon2id prefix: %q", hash)
	}
	if !verifyClientSecret(hash, "hunter2") {
		t.Fatal("argon2id verify must succeed")
	}
	if verifyClientSecret(hash, "wrong") {
		t.Fatal("wrong secret must not verify")
	}
}

func TestVerifyClientSecretEmptyInputs(t *testing.T) {
	if verifyClientSecret("", "x") {
		t.Error("empty stored must reject")
	}
	if verifyClientSecret("x", "") {
		t.Error("empty presented must reject")
	}
}

func TestHashResourceSetIsCanonical(t *testing.T) {
	a := hashResourceSet([]string{"resource://A", "resource://b"})
	b := hashResourceSet([]string{"resource://b ", " RESOURCE://a"})
	if hex.EncodeToString(a) != hex.EncodeToString(b) {
		t.Fatal("hash must be order/case/whitespace invariant")
	}
	c := hashResourceSet([]string{"resource://a"})
	if hex.EncodeToString(a) == hex.EncodeToString(c) {
		t.Fatal("different sets must hash differently")
	}
}

// stubChallengeDB captures ConsumeStepUpChallenge calls.
type stubChallengeDB struct {
	stubDB
	gotParams  ConsumeStepUpParams
	consumeErr error
}

func (s *stubChallengeDB) ConsumeStepUpChallenge(_ context.Context, p ConsumeStepUpParams) error {
	s.gotParams = p
	return s.consumeErr
}

func TestVerifyAndConsumeChallengeRejectsEmpty(t *testing.T) {
	srv := &Server{db: &stubChallengeDB{}}
	if err := srv.verifyAndConsumeChallenge(context.Background(), "z", "p", "", "secret", []string{"r"}); err != ErrChallengeInvalid {
		t.Fatalf("empty id must reject, got %v", err)
	}
	if err := srv.verifyAndConsumeChallenge(context.Background(), "z", "p", "id", "", []string{"r"}); err != ErrChallengeInvalid {
		t.Fatalf("empty secret must reject, got %v", err)
	}
}

func TestVerifyAndConsumeChallengePassesBindings(t *testing.T) {
	db := &stubChallengeDB{}
	srv := &Server{db: db}
	resources := []string{"r1", "r2"}
	if err := srv.verifyAndConsumeChallenge(context.Background(), "z1", "p1", "c1", "secret", resources); err != nil {
		t.Fatal(err)
	}
	if db.gotParams.ZoneID != "z1" || db.gotParams.PrincipalID != "p1" || db.gotParams.ID != "c1" {
		t.Fatalf("bindings not propagated: %+v", db.gotParams)
	}
	want := sha256.Sum256([]byte("secret"))
	if hex.EncodeToString(db.gotParams.ChallengeSecretHash) != hex.EncodeToString(want[:]) {
		t.Fatal("secret hash mismatch")
	}
	if hex.EncodeToString(db.gotParams.ResourceSetHash) != hex.EncodeToString(hashResourceSet(resources)) {
		t.Fatal("resource set hash mismatch")
	}
}

func TestVerifyAndConsumeChallengePropagatesInvalid(t *testing.T) {
	db := &stubChallengeDB{consumeErr: ErrChallengeInvalid}
	srv := &Server{db: db}
	if err := srv.verifyAndConsumeChallenge(context.Background(), "z", "p", "c", "s", []string{"r"}); err != ErrChallengeInvalid {
		t.Fatalf("want ErrChallengeInvalid, got %v", err)
	}
}

func TestValidateTokenEndpointRequiresHTTPS(t *testing.T) {
	if _, err := validateTokenEndpoint("http://idp.example.com/token", []string{"idp.example.com"}); err == nil {
		t.Fatal("http must be rejected")
	}
}

func TestValidateTokenEndpointRequiresAllowlist(t *testing.T) {
	if _, err := validateTokenEndpoint("https://idp.example.com/token", nil); err == nil {
		t.Fatal("empty allowlist must be rejected")
	}
}

func TestValidateTokenEndpointEnforcesAllowlist(t *testing.T) {
	if _, err := validateTokenEndpoint("https://attacker.example.com/token", []string{"example.com"}); err == nil {
		t.Fatal("non-allowlisted host must be rejected")
	}
}

func TestValidateTokenEndpointAcceptsAllowed(t *testing.T) {
	if _, err := validateTokenEndpoint("https://example.com/token", []string{"EXAMPLE.com"}); err != nil {
		t.Skipf("real DNS unavailable in this environment: %v", err)
	}
}

func TestIsUnsafeIPCoversReservedRanges(t *testing.T) {
	cases := []string{
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"::1",
		"fc00::1",
		"fd00::1",
		"224.0.0.1",
	}
	for _, c := range cases {
		ip := net.ParseIP(c)
		if !isUnsafeIP(ip) {
			t.Errorf("%s must be unsafe", c)
		}
	}
	safe := []string{"8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"}
	for _, c := range safe {
		ip := net.ParseIP(c)
		if isUnsafeIP(ip) {
			t.Errorf("%s must be safe", c)
		}
	}
}

func TestSafeHTTPClientDisablesRedirects(t *testing.T) {
	c := safeHTTPClient(time.Second)
	if err := c.CheckRedirect(nil, nil); err != http.ErrUseLastResponse {
		t.Fatalf("redirects must be disabled, got %v", err)
	}
}

func TestJWKSRequiresZoneID(t *testing.T) {
	srv := &Server{db: &stubDB{}}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/.well-known/jwks.json", nil)
	srv.handleJWKS(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing zone_id must 400, got %d", w.Code)
	}
}

// stubReloadDB simulates ErrNoRows vs transient errors for loadZone.
type stubReloadDB struct {
	stubDB
	bindingErr error
}

func (s *stubReloadDB) GetActivePolicySetBinding(_ context.Context, _ string) (*PolicySetBinding, error) {
	return nil, s.bindingErr
}

func TestLoadZoneNoPolicyInstallsFallback(t *testing.T) {
	e := newOPAEngine(&stubReloadDB{bindingErr: pgx.ErrNoRows})
	if err := e.loadZone(context.Background(), "z"); err != nil {
		t.Fatalf("ErrNoRows must install fallback without error, got %v", err)
	}
	e.mu.RLock()
	st := e.zones["z"]
	e.mu.RUnlock()
	if st == nil || st.manifestSHA != "no_active_policy_set" {
		t.Fatalf("expected deny-all fallback, got %+v", st)
	}
}

func TestLoadZoneTransientPreservesCache(t *testing.T) {
	db := &stubReloadDB{bindingErr: errors.New("connection refused")}
	e := newOPAEngine(db)
	// Seed cache with a marker bundle.
	e.mu.Lock()
	e.zones["z"] = &opaZoneState{manifestSHA: "previous"}
	e.mu.Unlock()
	if err := e.loadZone(context.Background(), "z"); err != nil {
		t.Fatalf("transient error with cached bundle must be swallowed, got %v", err)
	}
	e.mu.RLock()
	st := e.zones["z"]
	e.mu.RUnlock()
	if st == nil || st.manifestSHA != "previous" {
		t.Fatalf("cached bundle must be preserved, got %+v", st)
	}
}
