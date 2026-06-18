// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Identity verifier tests cover JWKS parsing, caching, and JWT claim enforcement.

package identity

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func testKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func jwkForKey(key *ecdsa.PrivateKey, kid string) map[string]string {
	pad := func(n *big.Int) string {
		bytes := n.Bytes()
		if len(bytes) < 32 {
			out := make([]byte, 32)
			copy(out[32-len(bytes):], bytes)
			bytes = out
		}
		return base64.RawURLEncoding.EncodeToString(bytes)
	}
	return map[string]string{
		"kty": "EC",
		"crv": "P-256",
		"kid": kid,
		"alg": "ES256",
		"use": "sig",
		"x":   pad(key.X),
		"y":   pad(key.Y),
	}
}

func issuerWithJWKS(t *testing.T, body func() string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body()))
	}))
	return srv, &calls
}

func signedToken(t *testing.T, key *ecdsa.PrivateKey, kid string, issuer string, overrides jwt.MapClaims) string {
	t.Helper()
	now := time.Now().Unix()
	claims := jwt.MapClaims{
		"iss":                    issuer,
		"aud":                    "resource://pipernet",
		"iat":                    now,
		"exp":                    now + 600,
		"jti":                    "jti-1",
		"sub":                    "user-1",
		"sid":                    "session-1",
		"root_sid":               "root-1",
		"client_id":              "app-1",
		"use":                    MandateUseResource,
		"sub_type":               SubjectTypeUser,
		"zone_id":                "zone-1",
		"scope":                  "read write control:*",
		"target":                 []string{"resource://pipernet"},
		"agent_session_id":       "agent-1",
		"delegation_edge_id":     "edge-1",
		"source_session_id":      "source-1",
		"target_session_id":      "target-1",
		"delegation_path":        []string{"app-0", "app-1"},
		"delegation_graph_epoch": 9,
		"hop_count":              2,
		"delegation_chain": []map[string]string{
			{"application_id": "app-0", "agent_session_id": "agent-0", "delegation_edge_id": "edge-0"},
			{"application_id": "app-1", "agent_session_id": "agent-1", "delegation_edge_id": "edge-1"},
		},
	}
	for key, value := range overrides {
		if value == nil {
			delete(claims, key)
		} else {
			claims[key] = value
		}
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = kid
	out, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestVerifyValidatesSignedClaimsAndChain(t *testing.T) {
	ResetJWKSCache()
	key := testKey(t)
	srv, calls := issuerWithJWKS(t, func() string {
		body, _ := json.Marshal(map[string]any{"keys": []any{jwkForKey(key, "kid-1")}})
		return string(body)
	})
	defer srv.Close()

	token := signedToken(t, key, "kid-1", srv.URL, nil)
	claims, err := Verify(token, Config{
		Issuer:               srv.URL,
		Audience:             "resource://pipernet",
		ZoneID:               "zone-1",
		RequiredScopes:       []string{"read"},
		RequiredTargets:      []string{"resource://pipernet"},
		RequiredUse:          MandateUseResource,
		RequireAgent:         true,
		RequireDelegation:    true,
		RequireChainContains: []string{"app-0"},
		MaxHopCount:          2,
	})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.Sub != "user-1" || claims.ClientID != "app-1" || claims.GraphEpoch != 9 || claims.HopCount != 2 {
		t.Fatalf("unexpected claims: %#v", claims)
	}
	if len(claims.TargetResources) != 1 || claims.TargetResources[0] != "resource://pipernet" {
		t.Fatalf("unexpected targets: %#v", claims.TargetResources)
	}
	if !VerifyChainContains(claims, "app-1") || !VerifyChainContains(claims, "app-0") || VerifyChainContains(claims, "missing") {
		t.Fatalf("chain membership mismatch: %#v", claims.DelegationChain)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected one JWKS fetch, got %d", calls.Load())
	}
	if _, err := Verify(token, Config{Issuer: srv.URL, Audience: "resource://pipernet"}); err != nil {
		t.Fatalf("cached verify: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected cached JWKS, got %d calls", calls.Load())
	}
}

func TestVerifyRejectsInvalidClaims(t *testing.T) {
	ResetJWKSCache()
	key := testKey(t)
	srv, _ := issuerWithJWKS(t, func() string {
		body, _ := json.Marshal(map[string]any{"keys": []any{jwkForKey(key, "kid-1")}})
		return string(body)
	})
	defer srv.Close()

	tests := []struct {
		name      string
		cfg       Config
		overrides jwt.MapClaims
		want      error
		typeCheck any
	}{
		{name: "bad zone", cfg: Config{ZoneID: "zone-2"}, want: ErrZoneInvalid},
		{name: "missing required scope", cfg: Config{RequiredScopes: []string{"delete"}}, want: &ScopeMissingError{}},
		{name: "missing required target", cfg: Config{RequiredTargets: []string{"resource://missing"}}, want: ErrTokenInvalid},
		{name: "missing agent", cfg: Config{RequireAgent: true}, overrides: jwt.MapClaims{"agent_session_id": ""}, want: ErrAgentIdentityRequired},
		{name: "missing delegation", cfg: Config{RequireDelegation: true}, overrides: jwt.MapClaims{"delegation_edge_id": ""}, want: ErrDelegationRequired},
		{name: "hop exceeded", cfg: Config{MaxHopCount: 1}, want: ErrHopCountExceeded},
		{name: "chain mismatch", cfg: Config{RequireChainContains: []string{"app-x"}}, want: &ChainMismatchError{}},
		{name: "invalid use", overrides: jwt.MapClaims{"use": "refresh"}, want: ErrTokenInvalid},
		{name: "invalid subject type", overrides: jwt.MapClaims{"sub_type": "robot"}, want: ErrTokenInvalid},
		{name: "invalid optional string", overrides: jwt.MapClaims{"source_session_id": 7}, want: ErrTokenInvalid},
		{name: "invalid optional int", overrides: jwt.MapClaims{"hop_count": -1}, want: ErrTokenInvalid},
		{name: "missing required string", overrides: jwt.MapClaims{"sid": nil}, want: ErrTokenInvalid},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token := signedToken(t, key, "kid-1", srv.URL, tt.overrides)
			cfg := tt.cfg
			cfg.Issuer = srv.URL
			cfg.Audience = "resource://pipernet"
			_, err := Verify(token, cfg)
			if err == nil {
				t.Fatal("expected error")
			}
			if _, ok := tt.want.(*ScopeMissingError); ok {
				var target *ScopeMissingError
				if !errors.As(err, &target) {
					t.Fatalf("expected ScopeMissingError, got %T %v", err, err)
				}
				return
			}
			if _, ok := tt.want.(*ChainMismatchError); ok {
				var target *ChainMismatchError
				if !errors.As(err, &target) {
					t.Fatalf("expected ChainMismatchError, got %T %v", err, err)
				}
				return
			}
			if !errors.Is(err, tt.want) {
				t.Fatalf("expected %v, got %v", tt.want, err)
			}
		})
	}
}

func TestVerifyRejectsSignatureAndJWKSFailures(t *testing.T) {
	ResetJWKSCache()
	key := testKey(t)
	other := testKey(t)
	srv, _ := issuerWithJWKS(t, func() string {
		body, _ := json.Marshal(map[string]any{"keys": []any{jwkForKey(other, "kid-1")}})
		return string(body)
	})
	defer srv.Close()

	token := signedToken(t, key, "kid-1", srv.URL, nil)
	if _, err := Verify(token, Config{Issuer: srv.URL, Audience: "resource://pipernet"}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("expected invalid signature, got %v", err)
	}
	if _, err := Verify(strings.TrimSuffix(token, "x")+"x", Config{Issuer: srv.URL, Audience: "resource://pipernet"}); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("expected malformed token error, got %v", err)
	}
}

func TestGetJWKSValidatesIssuersParsesAndCaches(t *testing.T) {
	ResetJWKSCache()
	key := testKey(t)
	srv, calls := issuerWithJWKS(t, func() string {
		body, _ := json.Marshal(map[string]any{"keys": []any{
			map[string]string{"kty": "RSA", "kid": "ignored"},
			jwkForKey(key, "kid-1"),
		}})
		return string(body)
	})
	defer srv.Close()

	keys, err := GetJWKS(srv.URL, "zone-1")
	if err != nil {
		t.Fatalf("jwks: %v", err)
	}
	if keys["kid-1"] == nil || len(keys) != 1 {
		t.Fatalf("unexpected keys: %#v", keys)
	}
	cached, err := GetJWKSContext(context.Background(), srv.URL, "zone-1")
	if err != nil {
		t.Fatalf("cached jwks: %v", err)
	}
	if fmt.Sprintf("%p", cached["kid-1"]) != fmt.Sprintf("%p", keys["kid-1"]) || calls.Load() != 1 {
		t.Fatalf("expected cached key, calls=%d", calls.Load())
	}

	if _, err := GetJWKS("ftp://issuer.example", "zone-1"); err == nil {
		t.Fatal("expected unsupported scheme error")
	}
	if _, err := GetJWKS("http://issuer.example", "zone-1"); err == nil {
		t.Fatal("expected insecure issuer error")
	}
	t.Setenv("CARACAL_ALLOW_INSECURE_CONFIG_URLS", "true")
	if err := assertSecureIssuer("http://issuer.example"); err != nil {
		t.Fatalf("env override should allow insecure issuer: %v", err)
	}
}

func TestGetJWKSHandlesFetchDecodeAndConcurrentCalls(t *testing.T) {
	ResetJWKSCache()
	errorSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer errorSrv.Close()
	if _, err := GetJWKS(errorSrv.URL, "zone-1"); err == nil {
		t.Fatal("expected status error")
	}

	badJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{`))
	}))
	defer badJSON.Close()
	if _, err := GetJWKS(badJSON.URL, "zone-1"); err == nil {
		t.Fatal("expected decode error")
	}

	key := testKey(t)
	good, _ := issuerWithJWKS(t, func() string {
		body, _ := json.Marshal(map[string]any{"keys": []any{jwkForKey(key, "kid-1")}})
		return string(body)
	})
	defer good.Close()
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := GetJWKS(good.URL, "zone-1"); err != nil {
				t.Errorf("concurrent jwks: %v", err)
			}
		}()
	}
	wg.Wait()
}

func TestParseECJWKRejectsUnsupportedKeys(t *testing.T) {
	key := testKey(t)
	valid := jwkForKey(key, "kid-1")
	if parsed, kid, err := ParseECJWK(mustJSON(t, valid)); err != nil || kid != "kid-1" || parsed.X.Sign() == 0 {
		t.Fatalf("valid jwk parse failed: kid=%s err=%v", kid, err)
	}
	withOps := map[string]any{}
	for k, v := range valid {
		withOps[k] = v
	}
	withOps["key_ops"] = []string{"verify"}
	if _, _, err := ParseECJWK(mustJSON(t, withOps)); err != nil {
		t.Fatalf("verify key_ops should parse: %v", err)
	}

	tests := []map[string]any{
		{"kty": "RSA", "crv": "P-256", "kid": "kid", "alg": "ES256"},
		{"kty": "EC", "crv": "P-384", "kid": "kid", "alg": "ES256"},
		{"kty": "EC", "crv": "P-256", "kid": "", "alg": "ES256"},
		{"kty": "EC", "crv": "P-256", "kid": "kid", "alg": "ES384"},
		{"kty": "EC", "crv": "P-256", "kid": "kid", "alg": "ES256", "use": "enc"},
		{"kty": "EC", "crv": "P-256", "kid": "kid", "alg": "ES256", "key_ops": []string{"sign"}},
		{"kty": "EC", "crv": "P-256", "kid": "kid", "alg": "ES256", "x": "bad", "y": valid["y"]},
		{"kty": "EC", "crv": "P-256", "kid": "kid", "alg": "ES256", "x": valid["x"], "y": "bad"},
		{"kty": "EC", "crv": "P-256", "kid": "kid", "alg": "ES256", "x": "AQ", "y": valid["y"]},
		{"kty": "EC", "crv": "P-256", "kid": "kid", "alg": "ES256", "x": valid["x"], "y": valid["x"]},
	}
	for i, tt := range tests {
		t.Run(fmt.Sprintf("case_%d", i), func(t *testing.T) {
			if _, _, err := ParseECJWK(mustJSON(t, tt)); err == nil {
				t.Fatal("expected error")
			}
		})
	}
	if _, _, err := ParseECJWK(json.RawMessage(`{`)); err == nil {
		t.Fatal("expected JSON error")
	}
}

func TestClaimReaderEdgeCases(t *testing.T) {
	if (&ScopeMissingError{Scope: "read"}).Error() != "missing scope: read" {
		t.Fatal("unexpected scope error")
	}
	if (&ChainMismatchError{ApplicationID: "app-1"}).Error() != "delegation chain missing application: app-1" {
		t.Fatal("unexpected chain error")
	}
	if readChain(nil) != nil || readChain("bad") != nil {
		t.Fatal("invalid chain shapes should return nil")
	}
	chain := readChain([]any{
		"skip",
		map[string]any{"application_id": ""},
		map[string]any{"application_id": "app-1", "agent_session_id": "agent-1", "delegation_edge_id": "edge-1"},
	})
	if len(chain) != 1 || chain[0].ApplicationID != "app-1" {
		t.Fatalf("unexpected chain: %#v", chain)
	}
	if readStringSlice(nil) != nil || readStringSlice("bad") != nil {
		t.Fatal("invalid string slice shapes should return nil")
	}
	if got := readStringSlice([]any{"a", 1, "b"}); strings.Join(got, ",") != "a,b" {
		t.Fatalf("unexpected strings: %#v", got)
	}
	if !requiredNumeric(jwt.MapClaims{"iat": float64(1)}, "iat") ||
		!requiredNumeric(jwt.MapClaims{"iat": int64(1)}, "iat") ||
		!requiredNumeric(jwt.MapClaims{"iat": json.Number("1")}, "iat") {
		t.Fatal("valid numeric values rejected")
	}
	if requiredNumeric(jwt.MapClaims{"iat": json.Number("bad")}, "iat") || requiredNumeric(jwt.MapClaims{"iat": "1"}, "iat") {
		t.Fatal("invalid numeric values accepted")
	}
	if got, ok := optionalInt(jwt.MapClaims{}, "hop_count"); !ok || got != 0 {
		t.Fatal("missing optional int should be zero and ok")
	}
	if got, ok := optionalInt(jwt.MapClaims{"hop_count": float64(3)}, "hop_count"); !ok || got != 3 {
		t.Fatal("float optional int rejected")
	}
	if got, ok := optionalInt(jwt.MapClaims{"hop_count": int64(3)}, "hop_count"); !ok || got != 3 {
		t.Fatal("int64 optional int rejected")
	}
	if got, ok := optionalInt(jwt.MapClaims{"hop_count": json.Number("3")}, "hop_count"); !ok || got != 3 {
		t.Fatal("json optional int rejected")
	}
	for _, value := range []any{float64(3.5), int64(-1), json.Number("-1"), json.Number("bad"), "3"} {
		if _, ok := optionalInt(jwt.MapClaims{"hop_count": value}, "hop_count"); ok {
			t.Fatalf("invalid optional int accepted: %#v", value)
		}
	}
	if _, ok := requiredInt64(jwt.MapClaims{}, "exp"); ok {
		t.Fatal("missing required int accepted")
	}
	if got, ok := requiredInt64(jwt.MapClaims{"exp": float64(0)}, "exp"); !ok || got != 0 {
		t.Fatal("present zero required int should be accepted")
	}
	if !isLoopbackHost("localhost") || !isLoopbackHost("127.0.0.1") || isLoopbackHost("example.com") {
		t.Fatal("loopback host detection mismatch")
	}
	if !containsKeyOp([]string{"sign", "verify"}, "verify") || containsKeyOp([]string{"sign"}, "verify") {
		t.Fatal("key op detection mismatch")
	}
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	out, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
