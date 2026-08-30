// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// testIssuer mimics the identity service: an ES256 key pair, its JWKS
// document, and token signing with the matching kid header.
type testIssuer struct {
	key *ecdsa.PrivateKey
	kid string
}

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	return &testIssuer{key: key, kid: hex.EncodeToString(sum[:])[:16]}
}

func (i *testIssuer) jwks() map[string]any {
	return map[string]any{"keys": []map[string]any{{
		"kty": "EC",
		"crv": "P-256",
		"x":   base64.RawURLEncoding.EncodeToString(i.key.X.FillBytes(make([]byte, 32))),
		"y":   base64.RawURLEncoding.EncodeToString(i.key.Y.FillBytes(make([]byte, 32))),
		"kid": i.kid,
		"use": "sig",
		"alg": "ES256",
	}}}
}

func (i *testIssuer) sign(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = i.kid
	signed, err := tok.SignedString(i.key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func accessClaims(userID uuid.UUID) jwt.MapClaims {
	return jwt.MapClaims{
		"sub":    userID.String(),
		"role":   "member",
		"email":  "member@example.com",
		"aud":    "caracal-api",
		"groups": []string{"eng"},
		"iat":    time.Now().Unix(),
		"exp":    time.Now().Add(time.Hour).Unix(),
	}
}

func jwksServer(t *testing.T, doc func() map[string]any, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if hits != nil {
			hits.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(doc()); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newAuthenticator(t *testing.T, issuer *testIssuer) *Authenticator {
	t.Helper()
	srv := jwksServer(t, issuer.jwks, nil)
	return New(NewKeySet(srv.URL, srv.Client()), "caracal-api", "")
}

func TestAuthenticateValidToken(t *testing.T) {
	issuer := newTestIssuer(t)
	userID := uuid.New()
	a := newAuthenticator(t, issuer)

	claims, err := a.Authenticate(context.Background(), issuer.sign(t, accessClaims(userID)))
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if claims.UserID != userID {
		t.Errorf("UserID = %s, want %s", claims.UserID, userID)
	}
	if claims.Role != "member" {
		t.Errorf("Role = %q", claims.Role)
	}
	if claims.Email != "member@example.com" {
		t.Errorf("Email = %q", claims.Email)
	}
	if claims.AuthContext != "" {
		t.Errorf("AuthContext = %q", claims.AuthContext)
	}
	if len(claims.Groups) != 1 || claims.Groups[0] != "eng" {
		t.Errorf("Groups = %v", claims.Groups)
	}
}

func TestAuthenticateCarriesAuthContext(t *testing.T) {
	issuer := newTestIssuer(t)
	userID := uuid.New()
	a := newAuthenticator(t, issuer)
	jwtClaims := accessClaims(userID)
	jwtClaims["auth_context"] = AuthContextOperator

	claims, err := a.Authenticate(context.Background(), issuer.sign(t, jwtClaims))
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if claims.AuthContext != AuthContextOperator {
		t.Errorf("AuthContext = %q", claims.AuthContext)
	}
}

func TestAuthenticateRejectsInvalidTokens(t *testing.T) {
	issuer := newTestIssuer(t)
	userID := uuid.New()
	a := newAuthenticator(t, issuer)

	expired := accessClaims(userID)
	expired["exp"] = time.Now().Add(-time.Minute).Unix()

	wrongAudience := accessClaims(userID)
	wrongAudience["aud"] = "someone-else"

	badSub := accessClaims(userID)
	badSub["sub"] = "not-a-uuid"

	noSub := accessClaims(userID)
	delete(noSub, "sub")

	noExp := accessClaims(userID)
	delete(noExp, "exp")

	tests := []struct {
		name  string
		token string
	}{
		{"expired", issuer.sign(t, expired)},
		{"wrong audience", issuer.sign(t, wrongAudience)},
		{"non-uuid subject", issuer.sign(t, badSub)},
		{"missing subject", issuer.sign(t, noSub)},
		{"missing exp", issuer.sign(t, noExp)},
		{"garbage", "not.a.jwt"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := a.Authenticate(context.Background(), tc.token); !errors.Is(err, ErrInvalidToken) {
				t.Errorf("err = %v, want ErrInvalidToken", err)
			}
		})
	}
}

func TestAuthenticateRejectsMissingKidAndForeignKey(t *testing.T) {
	issuer := newTestIssuer(t)
	forger := newTestIssuer(t) // key not in the served JWKS
	a := newAuthenticator(t, issuer)

	noKid := jwt.NewWithClaims(jwt.SigningMethodES256, accessClaims(uuid.New()))
	signed, err := noKid.SignedString(issuer.key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Authenticate(context.Background(), signed); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("missing kid: err = %v, want ErrInvalidToken", err)
	}

	if _, err := a.Authenticate(context.Background(), forger.sign(t, accessClaims(uuid.New()))); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("foreign key: err = %v, want ErrInvalidToken", err)
	}
}

func TestAuthenticateRejectsAlgorithmConfusion(t *testing.T) {
	issuer := newTestIssuer(t)
	a := newAuthenticator(t, issuer)

	// HS256 token using the kid of the EC key: the parser must refuse before
	// any HMAC comparison against key material can happen.
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims(uuid.New()))
	tok.Header["kid"] = issuer.kid
	signed, err := tok.SignedString([]byte("guessable"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Authenticate(context.Background(), signed); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("hs256 confusion: err = %v, want ErrInvalidToken", err)
	}
}

func TestKeySetPicksUpRotatedKeys(t *testing.T) {
	old := newTestIssuer(t)
	rotated := newTestIssuer(t)

	current := &atomic.Pointer[testIssuer]{}
	current.Store(old)
	var hits atomic.Int32
	srv := jwksServer(t, func() map[string]any { return current.Load().jwks() }, &hits)

	ks := NewKeySet(srv.URL, srv.Client())
	a := New(ks, "caracal-api", "")

	if _, err := a.Authenticate(context.Background(), old.sign(t, accessClaims(uuid.New()))); err != nil {
		t.Fatalf("pre-rotation token: %v", err)
	}

	// Rotate: new signing key, old kid no longer served.
	current.Store(rotated)
	ks.lastFetch = time.Time{} // bypass the refetch cooldown for the test

	if _, err := a.Authenticate(context.Background(), rotated.sign(t, accessClaims(uuid.New()))); err != nil {
		t.Fatalf("post-rotation token: %v", err)
	}
	if hits.Load() != 2 {
		t.Errorf("jwks fetched %d times, want 2 (initial + rotation refetch)", hits.Load())
	}
}

func TestKeySetRefetchCooldown(t *testing.T) {
	issuer := newTestIssuer(t)
	var hits atomic.Int32
	srv := jwksServer(t, issuer.jwks, &hits)
	ks := NewKeySet(srv.URL, srv.Client())

	if _, err := ks.Key(context.Background(), issuer.kid); err != nil {
		t.Fatal(err)
	}
	// Unknown kids within the cooldown must not trigger more fetches.
	for range 5 {
		if _, err := ks.Key(context.Background(), "no-such-kid"); err == nil {
			t.Fatal("expected error for unknown kid")
		}
	}
	if hits.Load() != 1 {
		t.Errorf("jwks fetched %d times, want 1", hits.Load())
	}
}

func TestBearerToken(t *testing.T) {
	tests := []struct {
		header string
		want   string
		ok     bool
	}{
		{"Bearer abc", "abc", true},
		{"Bearer   abc  ", "abc", true},
		{"Bearer ", "", false},
		{"bearer abc", "", false},
		{"", "", false},
		{"Basic abc", "", false},
	}
	for _, tc := range tests {
		got, ok := BearerToken(tc.header)
		if got != tc.want || ok != tc.ok {
			t.Errorf("BearerToken(%q) = (%q, %v), want (%q, %v)", tc.header, got, ok, tc.want, tc.ok)
		}
	}
}
