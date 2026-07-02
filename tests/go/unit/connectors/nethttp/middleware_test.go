// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// net/http middleware tests for claims propagation and request context deadlines.

package mcpnethttp_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	mcpnethttp "github.com/garudex-labs/caracal/packages/connectors/nethttp/go"
	"github.com/garudex-labs/caracal/packages/identity/go"
	"github.com/garudex-labs/caracal/packages/revocation/go"
	"github.com/golang-jwt/jwt/v5"
)

func TestMiddlewareAttachesClaimsToRequestContext(t *testing.T) {
	token, issuer, closeServer := mintToken(t, nil)
	defer closeServer()
	store := revocation.NewInMemoryStore(time.Hour)
	var claims identity.Claims
	var ok bool
	handler := mcpnethttp.Middleware(mcpnethttp.Options{
		Issuer:      issuer,
		Audience:    "resource://api",
		Revocations: store,
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok = mcpnethttp.ClaimsFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !ok || claims.Sub != "user-1" || claims.Sid != "sid-1" {
		t.Fatalf("expected verified claims in context, got ok=%v claims=%+v", ok, claims)
	}
}

func TestMiddlewareHonorsRequestContextDeadline(t *testing.T) {
	token, _, closeServer := mintToken(t, nil)
	defer closeServer()
	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer slow.Close()
	defer close(release)
	store := revocation.NewInMemoryStore(time.Hour)
	handler := mcpnethttp.Middleware(mcpnethttp.Options{
		Issuer:      slow.URL,
		Audience:    "resource://api",
		Revocations: store,
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("handler must not run when verification fails")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	ctx, cancel := context.WithTimeout(req.Context(), 50*time.Millisecond)
	defer cancel()
	req = req.WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	start := time.Now()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("middleware ignored the request deadline, took %v", elapsed)
	}
}

func mintToken(t *testing.T, claims jwt.MapClaims) (string, string, func()) {
	t.Helper()
	identity.ResetJWKSCache()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	jwk := publicJWK(key.PublicKey)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{jwk}})
	}))
	now := time.Now()
	base := jwt.MapClaims{
		"iss":       server.URL,
		"aud":       "resource://api",
		"sub":       "user-1",
		"zone_id":   "zone-1",
		"client_id": "app-1",
		"sid":       "sid-1",
		"root_sid":  "root-1",
		"use":       "resource",
		"sub_type":  "user",
		"jti":       "jti-1",
		"scope":     "mcp:call",
		"iat":       now.Unix(),
		"exp":       now.Add(5 * time.Minute).Unix(),
	}
	for k, v := range claims {
		base[k] = v
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, base)
	token.Header["kid"] = "kid-1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed, server.URL, server.Close
}

func publicJWK(key ecdsa.PublicKey) map[string]any {
	return map[string]any{
		"kty": "EC",
		"crv": "P-256",
		"kid": "kid-1",
		"use": "sig",
		"alg": "ES256",
		"x":   base64.RawURLEncoding.EncodeToString(paddedCoordinate(key.X)),
		"y":   base64.RawURLEncoding.EncodeToString(paddedCoordinate(key.Y)),
	}
}

func paddedCoordinate(v *big.Int) []byte {
	out := make([]byte, 32)
	b := v.Bytes()
	copy(out[32-len(b):], b)
	return out
}
