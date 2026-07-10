// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// MCP transport authentication tests for bearer parsing, JWT verification, and revocation checks.

package verify

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

	"github.com/garudex-labs/caracal/packages/identity/go"
	"github.com/golang-jwt/jwt/v5"
)

func TestExtractBearerAcceptsCaseAndWhitespace(t *testing.T) {
	tests := []struct {
		header string
		token  string
		ok     bool
	}{
		{"Bearer abc", "abc", true},
		{"bearer abc", "abc", true},
		{"  Bearer   abc.def.ghi  ", "abc.def.ghi", true},
		{"Bearer abc def", "abc def", true},
		{"Basic abc", "", false},
		{"Bearer", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.header, func(t *testing.T) {
			token, ok := ExtractBearer(tt.header)
			if token != tt.token || ok != tt.ok {
				t.Fatalf("got token=%q ok=%v, want token=%q ok=%v", token, ok, tt.token, tt.ok)
			}
		})
	}
}

func TestVerifierDefaultsRequireAndOverrides(t *testing.T) {
	baseRevocations := &fakeRevocations{}
	overrideRevocations := &fakeRevocations{}
	verifier := NewVerifier(Options{
		Issuer:          "https://issuer.example",
		Audience:        "resource://default",
		RequiredScopes:  []string{"read"},
		RequiredTargets: []string{"resource://default"},
		Revocations:     baseRevocations,
	})

	required := verifier.Require(Options{
		Audience:             "resource://route",
		RequiredScopes:       []string{"write"},
		RequiredTargets:      []string{"resource://route"},
		RequiredUse:          identity.MandateUseSession,
		RequireSession:       true,
		RequireDelegation:    true,
		RequireChainContains: []string{"app-hop"},
		MaxHopCount:          3,
		Revocations:          overrideRevocations,
	}).Defaults()

	if verifier.Defaults().Audience != "resource://default" {
		t.Fatal("Require must not mutate the original verifier defaults")
	}
	if required.Audience != "resource://route" || required.RequiredUse != identity.MandateUseSession {
		t.Fatalf("route overrides were not applied: %#v", required)
	}
	if !required.RequireSession || !required.RequireDelegation || required.MaxHopCount != 3 {
		t.Fatalf("boolean and hop overrides were not applied: %#v", required)
	}
	if required.Revocations != overrideRevocations || required.RequiredScopes[0] != "write" || required.RequiredTargets[0] != "resource://route" {
		t.Fatalf("slice/store overrides were not applied: %#v", required)
	}
}

func TestAuthenticateAcceptsValidTokenAndRouteOverrides(t *testing.T) {
	identity.ResetJWKSCache()
	privateKey := mustP256Key(t)
	var calls int64
	issuer := jwksServer(t, &privateKey.PublicKey, &calls)
	revocations := &fakeRevocations{}
	token := signedToken(t, privateKey, issuer, "resource://api", map[string]any{
		"scope":                  "read write",
		"target":                 []string{"resource://api", "resource://secondary"},
		"zone_id":                "zone-1",
		"agent_session_id":       "agent-1",
		"delegation_edge_id":     "edge-1",
		"delegation_chain":       []map[string]any{{"application_id": "app-hop", "agent_session_id": "agent-1", "delegation_edge_id": "edge-1"}},
		"delegation_path":        []string{"root", "agent-1"},
		"delegation_graph_epoch": 7,
		"hop_count":              1,
	})
	verifier := NewVerifier(Options{
		Issuer:      issuer,
		Audience:    "resource://api",
		ZoneID:      "zone-1",
		Revocations: revocations,
	})

	claims, authErr := verifier.Authorization("Bearer "+token, Options{
		RequiredScopes:       []string{"write"},
		RequiredTargets:      []string{"resource://secondary"},
		RequireSession:       true,
		RequireDelegation:    true,
		RequireChainContains: []string{"app-hop"},
		MaxHopCount:          2,
	})

	if authErr != nil {
		t.Fatalf("authenticate: %v", authErr)
	}
	if claims.AuthorityRecordID != "sid-1" || claims.SessionID != "agent-1" || claims.GraphEpoch != 7 {
		t.Fatalf("unexpected claims: %#v", claims)
	}
	if atomic.LoadInt64(&calls) != 1 {
		t.Fatalf("want one JWKS fetch, got %d", calls)
	}
}

func TestAuthenticateMapsIdentityAndRevocationFailures(t *testing.T) {
	identity.ResetJWKSCache()
	privateKey := mustP256Key(t)
	issuer := jwksServer(t, &privateKey.PublicKey, nil)
	valid := func(claims map[string]any) string {
		return signedToken(t, privateKey, issuer, "resource://api", claims)
	}

	tests := []struct {
		name   string
		token  string
		opts   Options
		code   ErrorCode
		detail string
	}{
		{name: "missing token", code: ErrMissingToken},
		{
			name:   "missing scope",
			token:  valid(map[string]any{"scope": "read", "zone_id": "zone-1"}),
			opts:   Options{RequiredScopes: []string{"write"}},
			code:   ErrInsufficientScope,
			detail: "Missing scope: write",
		},
		{
			name:  "invalid zone",
			token: valid(map[string]any{"scope": "read", "zone_id": "zone-other"}),
			code:  ErrInvalidZone,
		},
		{
			name:  "agent required",
			token: valid(map[string]any{"scope": "read", "zone_id": "zone-1"}),
			opts:  Options{RequireSession: true},
			code:  ErrSessionRequired,
		},
		{
			name:  "delegation required",
			token: valid(map[string]any{"scope": "read", "zone_id": "zone-1"}),
			opts:  Options{RequireDelegation: true},
			code:  ErrDelegationRequired,
		},
		{
			name:   "chain mismatch",
			token:  valid(map[string]any{"scope": "read", "zone_id": "zone-1", "delegation_chain": []map[string]any{{"application_id": "app-a"}}}),
			opts:   Options{RequireChainContains: []string{"app-b"}},
			code:   ErrChainMismatch,
			detail: "Delegation chain missing application: app-b",
		},
		{
			name:  "hop count",
			token: valid(map[string]any{"scope": "read", "zone_id": "zone-1", "hop_count": 3}),
			opts:  Options{MaxHopCount: 2},
			code:  ErrHopCountExceeded,
		},
		{
			name:  "revoked session",
			token: valid(map[string]any{"scope": "read", "zone_id": "zone-1"}),
			opts:  Options{Revocations: &fakeRevocations{revoked: map[string]bool{"sid-1": true}}},
			code:  ErrSessionRevoked,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts := Options{
				Issuer:      issuer,
				Audience:    "resource://api",
				ZoneID:      "zone-1",
				Revocations: &fakeRevocations{},
			}
			opts = mergeOptions(opts, tt.opts)
			_, authErr := Authenticate(tt.token, opts)
			if authErr == nil {
				t.Fatal("expected auth error")
			}
			if authErr.Code != tt.code {
				t.Fatalf("code=%s, want %s (%s)", authErr.Code, tt.code, authErr.Description)
			}
			if tt.detail != "" && authErr.Description != tt.detail {
				t.Fatalf("description=%q, want %q", authErr.Description, tt.detail)
			}
			if authErr.Hint == "" || authErr.Error() != authErr.Description {
				t.Fatalf("auth error should expose description and hint: %#v", authErr)
			}
		})
	}
}

func TestAuthenticateRejectsMissingRevocationStoreAndInvalidTokens(t *testing.T) {
	identity.ResetJWKSCache()
	privateKey := mustP256Key(t)
	issuer := jwksServer(t, &privateKey.PublicKey, nil)
	token := signedToken(t, privateKey, issuer, "resource://api", map[string]any{"scope": "read", "zone_id": "zone-1"})

	for name, opts := range map[string]Options{
		"missing-store": {Issuer: issuer, Audience: "resource://api", ZoneID: "zone-1"},
		"bad-token":     {Issuer: issuer, Audience: "resource://api", ZoneID: "zone-1", Revocations: &fakeRevocations{}},
	} {
		t.Run(name, func(t *testing.T) {
			value := token
			if name == "bad-token" {
				value = "not-a-jwt"
			}
			_, authErr := Authenticate(value, opts)
			if authErr == nil || authErr.Code != ErrInvalidToken {
				t.Fatalf("want invalid token error, got %#v", authErr)
			}
		})
	}
}

func TestCheckActiveAuthorityValidatesExpiryAndEveryAnchor(t *testing.T) {
	now := time.Unix(1_000, 0)
	active := identity.Claims{
		AuthorityRecordID:     "sid-1",
		RootAuthorityRecordID: "root-1",
		SessionID:             "agent-1",
		DelegationID:          "edge-1",
		ExpiresAt:             now.Add(time.Hour).Unix(),
	}

	if err := CheckActiveAuthority(active, &fakeRevocations{}, now); err != nil {
		t.Fatalf("active authority rejected: %v", err)
	}

	for _, anchor := range []string{"sid-1", "root-1", "agent-1", "edge-1"} {
		t.Run(anchor, func(t *testing.T) {
			err := CheckActiveAuthority(active, &fakeRevocations{revoked: map[string]bool{anchor: true}}, now)
			if err == nil || err.Code != ErrSessionRevoked {
				t.Fatalf("want session revoked for %s, got %#v", anchor, err)
			}
		})
	}

	for name, claims := range map[string]identity.Claims{
		"missing-sid": {ExpiresAt: now.Add(time.Hour).Unix()},
		"expired":     {AuthorityRecordID: "sid-1", ExpiresAt: now.Unix()},
	} {
		t.Run(name, func(t *testing.T) {
			err := CheckActiveAuthority(claims, &fakeRevocations{}, now)
			if err == nil || err.Code != ErrInvalidToken {
				t.Fatalf("want invalid token error, got %#v", err)
			}
		})
	}

	if err := CheckActiveAuthority(active, nil, now); err == nil || err.Description != "Revocation store required" {
		t.Fatalf("want revocation store required error, got %#v", err)
	}
}

type fakeRevocations struct {
	revoked map[string]bool
}

func (f *fakeRevocations) IsRevoked(anchorID string) bool {
	return f.revoked != nil && f.revoked[anchorID]
}

func (f *fakeRevocations) MarkRevoked(string, time.Duration) error {
	return nil
}

func mustP256Key(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return privateKey
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
		_ = json.NewEncoder(response).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "EC",
			"crv": "P-256",
			"kid": "kid1",
			"use": "sig",
			"alg": "ES256",
			"x":   b64URLUint(publicKey.X),
			"y":   b64URLUint(publicKey.Y),
		}}})
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func signedToken(t *testing.T, privateKey *ecdsa.PrivateKey, issuer, audience string, claims map[string]any) string {
	t.Helper()
	now := time.Now()
	mapClaims := jwt.MapClaims{
		"iss":       issuer,
		"aud":       audience,
		"exp":       now.Add(time.Hour).Unix(),
		"iat":       now.Unix(),
		"jti":       "jti-1",
		"sub":       "user-1",
		"root_sid":  "root-1",
		"sub_type":  "user",
		"sid":       "sid-1",
		"client_id": "app-1",
		"use":       "resource",
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
