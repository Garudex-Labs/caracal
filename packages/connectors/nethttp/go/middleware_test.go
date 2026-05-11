// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// net/http MCP middleware unit tests for JWT validation and JWKS caching.

package mcpnethttp

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/identity"
	transportmcp "github.com/garudex-labs/caracal/transport-mcp"
	"github.com/golang-jwt/jwt/v5"
)

func TestMiddlewareRejectsMissingBearer(t *testing.T) {
	handler := Middleware(Options{Issuer: "https://issuer.example", Audience: "resource://api"})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("next handler must not be called")
	}))
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/tool", nil)

	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", recorder.Code)
	}
}

func TestMiddlewareAcceptsValidScopedToken(t *testing.T) {
	identity.ResetJWKSCache()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	issuer := jwksServer(t, &privateKey.PublicKey, nil)
	token := signedToken(t, privateKey, issuer, "resource://api", map[string]interface{}{
		"sub":     "user1",
		"zone_id": "zone1",
		"scope":   "read write",
	})
	called := false
	handler := Middleware(Options{
		Issuer:         issuer,
		Audience:       "resource://api",
		ZoneID:         "zone1",
		RequiredScopes: []string{"write"},
	})(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		called = true
		response.WriteHeader(http.StatusNoContent)
	}))
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/tool", nil)
	req.Header.Set("Authorization", "Bearer "+token)

	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if !called {
		t.Fatal("next handler was not called")
	}
}

func TestMiddlewareRejectsMissingRequiredScope(t *testing.T) {
	identity.ResetJWKSCache()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	issuer := jwksServer(t, &privateKey.PublicKey, nil)
	token := signedToken(t, privateKey, issuer, "resource://api", map[string]interface{}{
		"sub":     "user1",
		"zone_id": "zone1",
		"scope":   "read",
	})
	handler := Middleware(Options{Issuer: issuer, Audience: "resource://api", ZoneID: "zone1", RequiredScopes: []string{"write"}})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("next handler must not be called")
	}))
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/tool", nil)
	req.Header.Set("Authorization", "Bearer "+token)

	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestMapErrorCoversTransportCodes(t *testing.T) {
	tests := []struct {
		code      transportmcp.ErrorCode
		status    int
		bodyError string
	}{
		{transportmcp.ErrInsufficientScope, http.StatusForbidden, "insufficient_scope"},
		{transportmcp.ErrAgentRequired, http.StatusUnauthorized, "agent_required"},
		{transportmcp.ErrDelegationRequired, http.StatusUnauthorized, "delegation_required"},
		{transportmcp.ErrChainMismatch, http.StatusUnauthorized, "chain_mismatch"},
		{transportmcp.ErrHopCountExceeded, http.StatusUnauthorized, "hop_count_exceeded"},
		{transportmcp.ErrSessionRevoked, http.StatusUnauthorized, "session_revoked"},
		{transportmcp.ErrInvalidZone, http.StatusUnauthorized, "invalid_zone"},
		{transportmcp.ErrMissingToken, http.StatusUnauthorized, "missing_token"},
		{transportmcp.ErrInvalidToken, http.StatusUnauthorized, "invalid_token"},
	}
	for _, tt := range tests {
		t.Run(string(tt.code), func(t *testing.T) {
			status, bodyError := mapError(tt.code)
			if status != tt.status || bodyError != tt.bodyError {
				t.Fatalf("want %d %q, got %d %q", tt.status, tt.bodyError, status, bodyError)
			}
		})
	}
}

func TestGetJWKSCachesKeysPerIssuer(t *testing.T) {
	identity.ResetJWKSCache()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	var calls int64
	issuer := jwksServer(t, &privateKey.PublicKey, &calls)

	first, err := identity.GetJWKS(issuer)
	if err != nil {
		t.Fatalf("first jwks fetch: %v", err)
	}
	second, err := identity.GetJWKS(issuer)
	if err != nil {
		t.Fatalf("second jwks fetch: %v", err)
	}

	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("want one key in both responses, got %d and %d", len(first), len(second))
	}
	if atomic.LoadInt64(&calls) != 1 {
		t.Fatalf("want one jwks fetch, got %d", calls)
	}
}

func jwksServer(t *testing.T, publicKey *ecdsa.PublicKey, calls *int64) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if calls != nil {
			atomic.AddInt64(calls, 1)
		}
		if request.URL.Path != "/.well-known/jwks.json" {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		json.NewEncoder(response).Encode(map[string]interface{}{"keys": []map[string]string{{
			"kty": "EC",
			"crv": "P-256",
			"kid": "kid1",
			"x":   b64URLUint(publicKey.X),
			"y":   b64URLUint(publicKey.Y),
		}}})
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func signedToken(t *testing.T, privateKey *ecdsa.PrivateKey, issuer, audience string, claims map[string]interface{}) string {
	t.Helper()
	mapClaims := jwt.MapClaims{
		"iss": issuer,
		"aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
	for key, value := range claims {
		mapClaims[key] = value
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, mapClaims)
	token.Header["kid"] = "kid1"
	signed, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

func b64URLUint(value *big.Int) string {
	bytes := value.Bytes()
	padded := make([]byte, 32)
	copy(padded[32-len(bytes):], bytes)
	return base64.RawURLEncoding.EncodeToString(padded)
}
