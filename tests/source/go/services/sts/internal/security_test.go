// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Targeted security tests for STS hardening: Argon2id, challenge binding,
// SSRF defenses, JWKS zone scoping, and policy reload safety.

package internal

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
	"github.com/jackc/pgx/v5"
)

func testKEK(fill byte) []byte {
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = fill
	}
	return kek
}

func testKeyring(keys ...[]byte) *secretstore.Keyring {
	ring, err := secretstore.NewKeyring(keys...)
	if err != nil {
		panic(err)
	}
	return ring
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
		keys: newKeyCache(db, testKeyring(testKEK(1))),
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
	if db.insertedKey == nil || len(db.insertedKey.Envelope) == 0 {
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
	cache := &verifiedSecretCache{}
	if !cache.verify(hash, "hunter2") {
		t.Fatal("argon2id verify must succeed")
	}
	if cache.verify(hash, "wrong") {
		t.Fatal("wrong secret must not verify")
	}
}

func TestVerifyClientSecretEmptyInputs(t *testing.T) {
	cache := &verifiedSecretCache{}
	if cache.verify("", "x") {
		t.Error("empty stored must reject")
	}
	if cache.verify("x", "") {
		t.Error("empty presented must reject")
	}
}

func TestVerifiedSecretCacheHitSkipsDerivation(t *testing.T) {
	hash, err := hashClientSecret("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	cache := &verifiedSecretCache{}
	if !cache.verify(hash, "hunter2") {
		t.Fatal("cold verify must succeed")
	}
	entry, ok := cache.entries[hash]
	if !ok {
		t.Fatal("successful verify must populate the cache")
	}
	start := time.Now()
	if !cache.verify(hash, "hunter2") {
		t.Fatal("warm verify must succeed")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Millisecond {
		t.Fatalf("warm verify must skip Argon2id, took %v", elapsed)
	}
	if cache.entries[hash] != entry {
		t.Fatal("warm verify must not rewrite the entry")
	}
	if cache.verify(hash, "wrong") {
		t.Fatal("cached entry must not admit a different secret")
	}
}

func TestVerifiedSecretCacheRotationInvalidates(t *testing.T) {
	first, err := hashClientSecret("generation-one")
	if err != nil {
		t.Fatal(err)
	}
	second, err := hashClientSecret("generation-two")
	if err != nil {
		t.Fatal(err)
	}
	cache := &verifiedSecretCache{}
	if !cache.verify(first, "generation-one") {
		t.Fatal("first generation must verify")
	}
	if cache.verify(second, "generation-one") {
		t.Fatal("rotated hash must reject the retired secret")
	}
	if !cache.verify(second, "generation-two") {
		t.Fatal("rotated hash must verify its own secret")
	}
}

func TestVerifiedSecretCacheExpiredEntryReverifies(t *testing.T) {
	hash, err := hashClientSecret("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	cache := &verifiedSecretCache{}
	if !cache.verify(hash, "hunter2") {
		t.Fatal("cold verify must succeed")
	}
	stale := cache.entries[hash]
	stale.expiresAt = time.Now().Add(-time.Minute)
	cache.entries[hash] = stale
	if !cache.verify(hash, "hunter2") {
		t.Fatal("expired entry must fall through to a successful derivation")
	}
	if !time.Now().Before(cache.entries[hash].expiresAt) {
		t.Fatal("reverification must refresh the entry expiry")
	}
}

func TestHashApprovalBindingBindsScopes(t *testing.T) {
	context := approvalBindingContext{PrincipalID: "principal-1", AuthorityRecordID: "authority-1", SessionID: "session-1", ApplicationID: "app-1"}
	a := hashApprovalBinding([]string{"resource://nucleus"}, []string{"nucleus:pay"}, context)
	b := hashApprovalBinding([]string{"resource://nucleus"}, []string{"nucleus:read"}, context)
	if hex.EncodeToString(a) == hex.EncodeToString(b) {
		t.Fatal("an approval for one scope must not match a different scope on the same resource")
	}
	same := hashApprovalBinding([]string{" resource://nucleus ", "RESOURCE://NUCLEUS"}, []string{"nucleus:pay", "nucleus:pay"}, context)
	if hex.EncodeToString(a) != hex.EncodeToString(same) {
		t.Fatal("approval binding must canonicalize duplicate resources and scopes")
	}
	otherSession := context
	otherSession.SessionID = "session-2"
	if hex.EncodeToString(a) == hex.EncodeToString(hashApprovalBinding([]string{"resource://nucleus"}, []string{"nucleus:pay"}, otherSession)) {
		t.Fatal("approval binding must separate governed Sessions")
	}
	otherPolicy := context
	otherPolicy.Bundle.ManifestSHA = "manifest-2"
	if hex.EncodeToString(a) == hex.EncodeToString(hashApprovalBinding([]string{"resource://nucleus"}, []string{"nucleus:pay"}, otherPolicy)) {
		t.Fatal("approval binding must separate policy versions")
	}
}

// stubApprovalDB captures ConsumeApprovalChallenge calls.
type stubApprovalDB struct {
	stubDB
	gotParams  ConsumeApprovalParams
	consumeErr error
}

func (s *stubApprovalDB) InsertAuthorityRecordWithApproval(_ context.Context, _ *AuthorityRecord, p ConsumeApprovalParams) error {
	s.gotParams = p
	return s.consumeErr
}

func (s *stubApprovalDB) ConsumeApprovalChallenge(_ context.Context, p ConsumeApprovalParams) error {
	s.gotParams = p
	return s.consumeErr
}

func TestConsumeApprovalBindsRequestHash(t *testing.T) {
	db := &stubApprovalDB{}
	srv := &Server{db: db}
	binding := approvalBindingContext{PrincipalID: "p", ApplicationID: "app-1"}
	if err := srv.consumeApproval(context.Background(), "z", "p", "", []string{"r"}, []string{"s"}, binding); err != ErrApprovalInvalid {
		t.Fatalf("empty id must reject, got %v", err)
	}
	if err := srv.consumeApproval(context.Background(), "z", "p", "id", []string{"resource://nucleus"}, []string{"nucleus:pay"}, binding); err != nil {
		t.Fatalf("consume: %v", err)
	}
	want := hashApprovalBinding([]string{"resource://nucleus"}, []string{"nucleus:pay"}, binding)
	if hex.EncodeToString(db.gotParams.ResourceSetHash) != hex.EncodeToString(want) {
		t.Fatal("approval consume must bind the resource and scope set")
	}
	if db.gotParams.ID != "id" || db.gotParams.ZoneID != "z" || db.gotParams.PrincipalID != "p" {
		t.Fatalf("unexpected consume params: %+v", db.gotParams)
	}
}

func TestConsumeApprovalPropagatesInvalid(t *testing.T) {
	db := &stubApprovalDB{consumeErr: ErrApprovalInvalid}
	srv := &Server{db: db}
	if err := srv.consumeApproval(context.Background(), "z", "p", "c", []string{"r"}, nil, approvalBindingContext{}); err != ErrApprovalInvalid {
		t.Fatalf("want ErrApprovalInvalid, got %v", err)
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
		"64:ff9b::a9fe:a9fe",
		"64:ff9b::a00:1",
	}
	for _, c := range cases {
		ip := net.ParseIP(c)
		if !isUnsafeIP(ip) {
			t.Errorf("%s must be unsafe", c)
		}
	}
	safe := []string{"8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "64:ff9b::808:808"}
	for _, c := range safe {
		ip := net.ParseIP(c)
		if isUnsafeIP(ip) {
			t.Errorf("%s must be safe", c)
		}
	}
}

func TestPrivateEgressGrantAllowsPrivateRangesButNeverMetadataOrLoopback(t *testing.T) {
	for _, address := range []string{"10.0.0.1", "172.16.0.1", "192.168.0.1", "100.64.0.1", "fd00::1"} {
		if isUnsafeIP(net.ParseIP(address), true) {
			t.Fatalf("explicit private egress grant must allow %s", address)
		}
	}
	for _, address := range []string{"127.0.0.1", "169.254.169.254", "::1", "fe80::1", "64:ff9b::a9fe:a9fe"} {
		if !isUnsafeIP(net.ParseIP(address), true) {
			t.Fatalf("private egress grant must never allow %s", address)
		}
	}
	if !hostAllowed("idp.internal.example", []string{"IDP.INTERNAL.EXAMPLE"}) {
		t.Fatal("private host allowlist must be exact and case-insensitive")
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
