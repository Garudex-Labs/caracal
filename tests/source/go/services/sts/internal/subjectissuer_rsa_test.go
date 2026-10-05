// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs

package internal

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestSubjectIssuerRSAJWKSVerifiesRealSignature(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	enc := func(n *big.Int) string { return base64.RawURLEncoding.EncodeToString(n.Bytes()) }
	doc, err := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kid": "rsa-1", "kty": "RSA", "use": "sig", "n": enc(key.N), "e": enc(big.NewInt(int64(key.E))),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	cache := newSubjectKeyCache()
	fetches := 0
	cache.fetch = func(_ context.Context, url string) ([]byte, error) {
		fetches++
		if url != "https://issuer.example/jwks" {
			t.Errorf("unexpected trust URL %q", url)
		}
		return doc, nil
	}
	issuer := &SubjectIssuer{ID: "issuer-1", JWKSURL: "https://issuer.example/jwks"}
	keys, err := cache.keysFor(context.Background(), issuer)
	if err != nil {
		t.Fatal(err)
	}
	pub, ok := keys["rsa-1"].(*rsa.PublicKey)
	if !ok {
		t.Fatalf("expected RSA public key, got %T", keys["rsa-1"])
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"sub": "user-1", "exp": time.Now().Add(time.Hour).Unix()})
	token.Header["kid"] = "rsa-1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jwt.Parse(signed, func(*jwt.Token) (any, error) { return pub, nil }, jwt.WithValidMethods([]string{"RS256"})); err != nil {
		t.Fatalf("JWKS key did not verify the issuer's token: %v", err)
	}
	if _, err := cache.keysFor(context.Background(), issuer); err != nil || fetches != 1 {
		t.Fatalf("live trust cache must avoid another fetch: %v (%d fetches)", err, fetches)
	}
	cache.byID[issuer.ID] = subjectKeySet{keys: keys, jwksURL: issuer.JWKSURL, fetchedAt: time.Now().Add(-subjectJWKSCacheTTL)}
	cache.fetch = func(context.Context, string) ([]byte, error) { return nil, errors.New("issuer down") }
	if _, err := cache.keysFor(context.Background(), issuer); err == nil || !strings.Contains(err.Error(), "issuer down") {
		t.Fatalf("expired keys must fail closed when refresh fails, got %v", err)
	}
}

func TestSubjectIssuerRejectsMalformedRSAKeys(t *testing.T) {
	for _, tc := range []struct{ name, n, e string }{
		{"bad modulus", "%%%", "AQAB"},
		{"bad exponent", "AQAB", "%%%"},
		{"empty modulus", "", "AQAB"},
		{"zero exponent", "AQAB", "AA"},
		{"huge exponent", "AQAB", "//////////8"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc, err := json.Marshal(map[string]any{"keys": []subjectJWK{{Kty: "RSA", Kid: "bad", N: tc.n, E: tc.e}}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := parseSubjectJWKS(doc); err == nil || !strings.Contains(err.Error(), "no usable signing keys") {
				t.Fatalf("malformed signing key must be rejected, got %v", err)
			}
		})
	}
}

func TestSubjectJWKSFetchRejectsUnsafeURLs(t *testing.T) {
	for _, raw := range []string{"https://[", "http://issuer.example/jwks", "https:///jwks"} {
		if _, err := fetchSubjectJWKS(context.Background(), raw); err == nil {
			t.Errorf("unsafe JWKS URL %q accepted", raw)
		}
	}
	// The egress guard must reject loopback before a connection is attempted.
	_, err := fetchSubjectJWKS(context.Background(), "https://127.0.0.1:1/jwks")
	if err == nil || !strings.Contains(err.Error(), "blocked address") {
		t.Fatalf("private issuer address must be blocked, got %v", err)
	}
}
