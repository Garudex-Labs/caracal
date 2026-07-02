// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Transport MCP authentication tests for bearer parsing, JWT claims, and revocation.

package transportmcp_test

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

	"github.com/garudex-labs/caracal/packages/identity/go"
	"github.com/garudex-labs/caracal/packages/revocation/go"
	transportmcp "github.com/garudex-labs/caracal/packages/transport/mcp/go"
	"github.com/golang-jwt/jwt/v5"
)

func TestExtractBearer(t *testing.T) {
	if got, ok := transportmcp.ExtractBearer("Bearer token-1"); !ok || got != "token-1" {
		t.Fatalf("expected bearer token, got %q ok=%v", got, ok)
	}
	if got, ok := transportmcp.ExtractBearer("bearer token-1"); !ok || got != "token-1" {
		t.Fatalf("expected lowercase bearer token, got %q ok=%v", got, ok)
	}
	if got, ok := transportmcp.ExtractBearer("BEARER token-1"); !ok || got != "token-1" {
		t.Fatalf("expected uppercase bearer token, got %q ok=%v", got, ok)
	}
	if _, ok := transportmcp.ExtractBearer("Bearer   "); ok {
		t.Fatal("expected blank bearer token to be rejected")
	}
}

func TestAuthenticateRejectsMissingToken(t *testing.T) {
	_, authErr := transportmcp.Authenticate("", transportmcp.Options{})
	if authErr == nil || authErr.Code != transportmcp.ErrMissingToken {
		t.Fatalf("expected missing token error, got %#v", authErr)
	}
}

func TestAuthenticateAcceptsVerifiedTokenAndChecksRevocation(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{
		"scope":                  "mcp:call",
		"sid":                    "sid-1",
		"root_sid":               "root-1",
		"agent_session_id":       "agent-1",
		"delegation_edge_id":     "edge-1",
		"delegation_chain":       []map[string]any{{"application_id": "app-parent"}},
		"hop_count":              2,
		"client_id":              "app-1",
		"source_session_id":      "agent-root",
		"target_session_id":      "agent-1",
		"delegation_path":        []string{"edge-root", "edge-1"},
		"delegation_graph_epoch": 7,
		"target":                 []string{"resource://api"},
	})
	defer closeServer()
	store := revocation.NewInMemoryStore(time.Hour)

	claims, authErr := transportmcp.Authenticate(token, transportmcp.Options{
		Issuer:               issuer,
		Audience:             "resource://api",
		ZoneID:               "zone-1",
		RequiredScopes:       []string{"mcp:call"},
		RequiredTargets:      []string{"resource://api"},
		RequireAgent:         true,
		RequireDelegation:    true,
		RequireChainContains: []string{"app-parent"},
		MaxHopCount:          3,
		Revocations:          store,
	})
	if authErr != nil {
		t.Fatalf("unexpected auth error: %#v", authErr)
	}
	if claims.Sub != "user-1" || claims.RootSid != "root-1" || claims.AgentSessionID != "agent-1" || claims.DelegationEdgeID != "edge-1" || claims.HopCount != 2 {
		t.Fatalf("unexpected claims: %#v", claims)
	}
}

func TestAuthenticateRejectsRevokedSession(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"scope": "mcp:call", "sid": "sid-1"})
	defer closeServer()
	store := revocation.NewInMemoryStore(time.Hour)
	if err := store.MarkRevoked("sid-1", time.Hour); err != nil {
		t.Fatalf("mark revoked: %v", err)
	}

	_, authErr := transportmcp.Authenticate(token, transportmcp.Options{
		Issuer:      issuer,
		Audience:    "resource://api",
		Revocations: store,
	})
	if authErr == nil || authErr.Code != transportmcp.ErrSessionRevoked {
		t.Fatalf("expected session_revoked, got %#v", authErr)
	}
}

func TestAuthenticateRejectsRevokedAuthorityAnchors(t *testing.T) {
	tests := []struct {
		name    string
		claims  jwt.MapClaims
		revoked string
	}{
		{name: "root", claims: jwt.MapClaims{"root_sid": "root-1"}, revoked: "root-1"},
		{name: "agent", claims: jwt.MapClaims{"agent_session_id": "agent-1"}, revoked: "agent-1"},
		{name: "delegation", claims: jwt.MapClaims{"delegation_edge_id": "edge-1"}, revoked: "edge-1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token, issuer, closeServer := mintToken(t, tt.claims)
			defer closeServer()
			store := revocation.NewInMemoryStore(time.Hour)
			if err := store.MarkRevoked(tt.revoked, time.Hour); err != nil {
				t.Fatalf("mark revoked: %v", err)
			}
			_, authErr := transportmcp.Authenticate(token, transportmcp.Options{
				Issuer:      issuer,
				Audience:    "resource://api",
				Revocations: store,
			})
			if authErr == nil || authErr.Code != transportmcp.ErrSessionRevoked {
				t.Fatalf("expected session_revoked, got %#v", authErr)
			}
		})
	}
}

func TestCheckActiveAuthorityRejectsExpiredExecution(t *testing.T) {
	store := revocation.NewInMemoryStore(time.Hour)
	authErr := transportmcp.CheckActiveAuthority(identity.Claims{
		Sid:       "sid-1",
		ExpiresAt: time.Now().Add(-time.Second).Unix(),
	}, store, time.Now())
	if authErr == nil || authErr.Code != transportmcp.ErrInvalidToken {
		t.Fatalf("expected invalid_token, got %#v", authErr)
	}
}

func TestAuthenticateMapsIdentityErrors(t *testing.T) {
	tests := []struct {
		name   string
		opts   transportmcp.Options
		claims jwt.MapClaims
		code   transportmcp.ErrorCode
	}{
		{name: "scope", opts: transportmcp.Options{RequiredScopes: []string{"admin:call"}}, claims: jwt.MapClaims{"scope": "mcp:call"}, code: transportmcp.ErrInsufficientScope},
		{name: "target", opts: transportmcp.Options{RequiredTargets: []string{"resource://tools/calendar"}}, claims: jwt.MapClaims{"scope": "mcp:call", "target": []string{"resource://tools/files"}}, code: transportmcp.ErrInvalidToken},
		{name: "session mandate", opts: transportmcp.Options{}, claims: jwt.MapClaims{"scope": "mcp:call", "use": "session"}, code: transportmcp.ErrInvalidToken},
		{name: "zone", opts: transportmcp.Options{ZoneID: "zone-2"}, claims: jwt.MapClaims{"scope": "mcp:call"}, code: transportmcp.ErrInvalidZone},
		{name: "agent", opts: transportmcp.Options{RequireAgent: true}, claims: jwt.MapClaims{"scope": "mcp:call"}, code: transportmcp.ErrAgentRequired},
		{name: "delegation", opts: transportmcp.Options{RequireDelegation: true}, claims: jwt.MapClaims{"scope": "mcp:call"}, code: transportmcp.ErrDelegationRequired},
		{name: "chain", opts: transportmcp.Options{RequireChainContains: []string{"app-parent"}}, claims: jwt.MapClaims{"scope": "mcp:call", "delegation_chain": []map[string]any{{"application_id": "app-child"}}}, code: transportmcp.ErrChainMismatch},
		{name: "hop", opts: transportmcp.Options{MaxHopCount: 1}, claims: jwt.MapClaims{"scope": "mcp:call", "hop_count": 2}, code: transportmcp.ErrHopCountExceeded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token, issuer, closeServer := mintToken(t, tt.claims)
			defer closeServer()
			tt.opts.Issuer = issuer
			tt.opts.Audience = "resource://api"
			_, authErr := transportmcp.Authenticate(token, tt.opts)
			if authErr == nil || authErr.Code != tt.code {
				t.Fatalf("expected %s, got %#v", tt.code, authErr)
			}
		})
	}
}

func TestAuthenticateMapsInvalidToken(t *testing.T) {
	_, authErr := transportmcp.Authenticate("not-a-jwt", transportmcp.Options{Issuer: "https://issuer.example.com", Audience: "resource://api"})
	if authErr == nil || authErr.Code != transportmcp.ErrInvalidToken {
		t.Fatalf("expected invalid_token, got %#v", authErr)
	}
}

func TestAuthenticateContextHonorsCallerDeadline(t *testing.T) {
	token, _, closeServer := mintToken(t, nil)
	defer closeServer()
	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer slow.Close()
	defer close(release)
	store := revocation.NewInMemoryStore(time.Hour)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, authErr := transportmcp.AuthenticateContext(ctx, token, transportmcp.Options{
		Issuer:      slow.URL,
		Audience:    "resource://api",
		Revocations: store,
	})
	if authErr == nil || authErr.Code != transportmcp.ErrInvalidToken {
		t.Fatalf("expected invalid_token, got %#v", authErr)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("authentication ignored the caller deadline, took %v", elapsed)
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
