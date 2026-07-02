// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Identity package tests for JWT verification, claims extraction, and chain checks.

package identity_test

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
	"github.com/golang-jwt/jwt/v5"
)

func mintToken(t *testing.T, extra jwt.MapClaims) (string, string, func()) {
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
		"scope":     "read write",
		"iat":       now.Unix(),
		"exp":       now.Add(5 * time.Minute).Unix(),
	}
	for k, v := range extra {
		base[k] = v
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, base)
	tok.Header["kid"] = "kid-1"
	signed, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed, server.URL, server.Close
}

func publicJWK(key ecdsa.PublicKey) map[string]any {
	return map[string]any{
		"kty": "EC", "crv": "P-256", "kid": "kid-1", "use": "sig", "alg": "ES256",
		"x": base64.RawURLEncoding.EncodeToString(paddedCoord(key.X)),
		"y": base64.RawURLEncoding.EncodeToString(paddedCoord(key.Y)),
	}
}

func paddedCoord(v *big.Int) []byte {
	out := make([]byte, 32)
	b := v.Bytes()
	copy(out[32-len(b):], b)
	return out
}

func TestVerifyAcceptsValidTokenAndExtractsClaims(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{
		"sid":                    "sid-1",
		"root_sid":               "root-1",
		"client_id":              "app-1",
		"agent_session_id":       "agent-1",
		"delegation_edge_id":     "edge-1",
		"source_session_id":      "src-1",
		"target_session_id":      "tgt-1",
		"target":                 []string{"resource://api"},
		"delegation_path":        []string{"edge-0", "edge-1"},
		"delegation_chain":       []map[string]any{{"application_id": "app-parent", "agent_session_id": "s1", "delegation_edge_id": "e1"}},
		"hop_count":              float64(2),
		"delegation_graph_epoch": float64(7),
	})
	defer closeServer()

	claims, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if claims.Sub != "user-1" || claims.ZoneID != "zone-1" || claims.ClientID != "app-1" || claims.Sid != "sid-1" {
		t.Fatalf("wrong basic claims: %+v", claims)
	}
	if claims.RootSid != "root-1" || claims.SubType != "user" || claims.IssuedAt == 0 || claims.ExpiresAt <= claims.IssuedAt {
		t.Fatalf("wrong authority timing claims: %+v", claims)
	}
	if claims.AgentSessionID != "agent-1" || claims.DelegationEdgeID != "edge-1" {
		t.Fatalf("wrong identity claims: %+v", claims)
	}
	if claims.SourceSessionID != "src-1" || claims.TargetSessionID != "tgt-1" {
		t.Fatalf("wrong session claims: %+v", claims)
	}
	if len(claims.TargetResources) != 1 || claims.TargetResources[0] != "resource://api" {
		t.Fatalf("wrong target resources: %+v", claims.TargetResources)
	}
	if claims.HopCount != 2 || claims.GraphEpoch != 7 {
		t.Fatalf("wrong numeric claims: %+v", claims)
	}
	if len(claims.DelegationPath) != 2 {
		t.Fatalf("wrong path length: %v", claims.DelegationPath)
	}
	if len(claims.DelegationChain) != 1 || claims.DelegationChain[0].ApplicationID != "app-parent" ||
		claims.DelegationChain[0].AgentSessionID != "s1" || claims.DelegationChain[0].DelegationEdgeID != "e1" {
		t.Fatalf("wrong chain: %+v", claims.DelegationChain)
	}
}

func TestVerifyRejectsInvalidToken(t *testing.T) {
	identity.ResetJWKSCache()
	_, err := identity.Verify("not.a.jwt", identity.Config{Issuer: "https://issuer.example.com", Audience: "resource://api"})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestVerifyContextHonorsCallerDeadline(t *testing.T) {
	token, _, closeServer := mintToken(t, nil)
	defer closeServer()
	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer slow.Close()
	defer close(release)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := identity.VerifyContext(ctx, token, identity.Config{Issuer: slow.URL, Audience: "resource://api"})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("verification ignored the caller deadline, took %v", elapsed)
	}
}

func TestVerifyRejectsMissingZone(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"zone_id": ""})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api"})
	if err != identity.ErrZoneInvalid {
		t.Fatalf("expected ErrZoneInvalid, got %v", err)
	}
}

func TestVerifyRejectsMissingExpiration(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"exp": nil})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api"})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestVerifyRejectsMissingSessionID(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"sid": ""})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api"})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestVerifyRejectsMissingRootSessionID(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"root_sid": ""})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api"})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestVerifyRejectsMissingSubjectType(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"sub_type": ""})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api"})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestVerifyRejectsWrongTokenUse(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"use": "session"})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api", RequiredUse: "resource"})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestVerifyRejectsWrongZone(t *testing.T) {
	token, issuer, closeServer := mintToken(t, nil)
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api", ZoneID: "zone-99"})
	if err != identity.ErrZoneInvalid {
		t.Fatalf("expected ErrZoneInvalid, got %v", err)
	}
}

func TestVerifyRejectsMissingRequiredScope(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"scope": "read"})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api", RequiredScopes: []string{"admin"}})
	scopeErr, ok := err.(*identity.ScopeMissingError)
	if !ok {
		t.Fatalf("expected *ScopeMissingError, got %T: %v", err, err)
	}
	if scopeErr.Scope != "admin" {
		t.Fatalf("wrong missing scope: %q", scopeErr.Scope)
	}
}

func TestVerifyRejectsMissingRequiredTarget(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"target": []string{"resource://tools/files"}})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api", RequiredTargets: []string{"resource://tools/calendar"}})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestVerifyRejectsAgentRequired(t *testing.T) {
	token, issuer, closeServer := mintToken(t, nil)
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api", RequireAgent: true})
	if err != identity.ErrAgentIdentityRequired {
		t.Fatalf("expected ErrAgentIdentityRequired, got %v", err)
	}
}

func TestVerifyRejectsDelegationRequired(t *testing.T) {
	token, issuer, closeServer := mintToken(t, nil)
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api", RequireDelegation: true})
	if err != identity.ErrDelegationRequired {
		t.Fatalf("expected ErrDelegationRequired, got %v", err)
	}
}

func TestVerifyRejectsMalformedAgentClaim(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"agent_session_id": []string{"agent-1"}})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api", RequireAgent: true})
	if err != identity.ErrTokenInvalid {
		t.Fatalf("expected ErrTokenInvalid, got %v", err)
	}
}

func TestVerifyRejectsHopCountExceeded(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"hop_count": float64(5)})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api", MaxHopCount: 3})
	if err != identity.ErrHopCountExceeded {
		t.Fatalf("expected ErrHopCountExceeded, got %v", err)
	}
}

func TestVerifyRejectsChainMismatch(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{
		"delegation_chain": []map[string]any{{"application_id": "app-child"}},
	})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{
		Issuer:               issuer,
		Audience:             "resource://api",
		RequireChainContains: []string{"app-parent"},
	})
	chainErr, ok := err.(*identity.ChainMismatchError)
	if !ok {
		t.Fatalf("expected *ChainMismatchError, got %T: %v", err, err)
	}
	if chainErr.ApplicationID != "app-parent" {
		t.Fatalf("wrong missing application: %q", chainErr.ApplicationID)
	}
}

func TestVerifyChainHopNames(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{
		"delegation_chain": []map[string]any{
			{"application_id": "app-parent", "agent_session_id": "s1", "delegation_edge_id": "e1"},
		},
	})
	defer closeServer()

	claims, err := identity.Verify(token, identity.Config{
		Issuer:               issuer,
		Audience:             "resource://api",
		RequireChainContains: []string{"app-parent"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	hop := claims.DelegationChain[0]
	if hop.ApplicationID != "app-parent" || hop.AgentSessionID != "s1" || hop.DelegationEdgeID != "e1" {
		t.Fatalf("wrong chain hop: %+v", hop)
	}
}

func TestVerifyRejectsCompactChainKeys(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{
		"delegation_chain": []map[string]any{
			{"app": "app-parent", "session": "s1", "edge": "e1"},
		},
	})
	defer closeServer()

	_, err := identity.Verify(token, identity.Config{
		Issuer:               issuer,
		Audience:             "resource://api",
		RequireChainContains: []string{"app-parent"},
	})
	if err == nil {
		t.Fatal("expected ChainMismatchError: only full-form chain hop keys are supported")
	}
	if _, ok := err.(*identity.ChainMismatchError); !ok {
		t.Fatalf("expected *ChainMismatchError, got %T: %v", err, err)
	}
}

func TestErrorMessages(t *testing.T) {
	if got := (&identity.ScopeMissingError{Scope: "admin"}).Error(); got != "missing scope: admin" {
		t.Fatalf("unexpected ScopeMissingError message: %q", got)
	}
	if got := (&identity.ChainMismatchError{ApplicationID: "app-x"}).Error(); got != "delegation chain missing application: app-x" {
		t.Fatalf("unexpected ChainMismatchError message: %q", got)
	}
}

func TestVerifyChainContains(t *testing.T) {
	claims := identity.Claims{
		ClientID: "app-1",
		DelegationChain: []identity.ChainHop{
			{ApplicationID: "app-parent"},
		},
	}

	if !identity.VerifyChainContains(claims, "app-1") {
		t.Fatal("expected match by clientID")
	}
	if !identity.VerifyChainContains(claims, "app-parent") {
		t.Fatal("expected match in delegation chain")
	}
	if identity.VerifyChainContains(claims, "app-unknown") {
		t.Fatal("expected no match for unknown application")
	}
}

func TestVerifyIgnoresLegacyGraphEpochClaim(t *testing.T) {
	token, issuer, closeServer := mintToken(t, jwt.MapClaims{"graph_epoch": float64(99)})
	defer closeServer()

	claims, err := identity.Verify(token, identity.Config{Issuer: issuer, Audience: "resource://api"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if claims.GraphEpoch != 0 {
		t.Fatalf("expected GraphEpoch 0 for legacy claim, got %d", claims.GraphEpoch)
	}
}

func TestHasScope(t *testing.T) {
	tests := []struct {
		scope  string
		target string
		want   bool
	}{
		{"read write admin", "write", true},
		{"read write", "admin", false},
		{"readonly", "read", false},
		{"", "read", false},
		{"read write", "", false},
	}
	for _, tt := range tests {
		if got := identity.HasScope(tt.scope, tt.target); got != tt.want {
			t.Errorf("HasScope(%q, %q) = %v, want %v", tt.scope, tt.target, got, tt.want)
		}
	}
}
