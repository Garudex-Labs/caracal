// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Subject federation tests: JWKS parsing, external id_token validation, and the federation exchange.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const federationIssuer = "https://login.hooli.example"

func federationKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate issuer key: %v", err)
	}
	return key
}

func federationJWKS(t *testing.T, key *ecdsa.PrivateKey, kid string) []byte {
	t.Helper()
	coord := func(b []byte) string {
		padded := make([]byte, 32)
		copy(padded[32-len(b):], b)
		return base64.RawURLEncoding.EncodeToString(padded)
	}
	doc := map[string]any{"keys": []map[string]any{{
		"kty": "EC", "crv": "P-256", "kid": kid, "use": "sig",
		"x": coord(key.PublicKey.X.Bytes()),
		"y": coord(key.PublicKey.Y.Bytes()),
	}}}
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal jwks: %v", err)
	}
	return data
}

func federationIDToken(t *testing.T, key *ecdsa.PrivateKey, kid string, mutate func(jwt.MapClaims)) string {
	t.Helper()
	claims := jwt.MapClaims{
		"iss": federationIssuer,
		"aud": "pipernet-api",
		"sub": "user_123",
		"exp": time.Now().Add(5 * time.Minute).Unix(),
		"iat": time.Now().Add(-time.Minute).Unix(),
	}
	if mutate != nil {
		mutate(claims)
	}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = kid
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign id_token: %v", err)
	}
	return signed
}

func federationServer(t *testing.T, db DBQuerier, jwks []byte) *Server {
	t.Helper()
	srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
	srv.subjectKeys = newSubjectKeyCache()
	srv.subjectKeys.fetch = func(_ context.Context, _ string) ([]byte, error) {
		if jwks == nil {
			return nil, errors.New("fetch disabled")
		}
		return jwks, nil
	}
	return srv
}

func federationRequest(idToken string) TokenExchangeRequest {
	return TokenExchangeRequest{
		GrantType:        "urn:ietf:params:oauth:grant-type:token-exchange",
		SubjectToken:     idToken,
		SubjectTokenType: SubjectTokenTypeIDToken,
		ZoneID:           "zone1",
		ApplicationID:    "app1",
		ClientSecret:     "piper-secret",
	}
}

func trustedIssuerDB(t *testing.T) *stubDB {
	t.Helper()
	db := exchangeFlowDB(t)
	db.subjectIssuer = &SubjectIssuer{
		ID: "si1", ZoneID: "zone1", Issuer: federationIssuer,
		JWKSURL: "https://login.hooli.example/jwks", Audience: "pipernet-api",
	}
	return db
}

func TestParseSubjectJWKS(t *testing.T) {
	key := federationKey(t)
	keys, err := parseSubjectJWKS(federationJWKS(t, key, "ext-kid"))
	if err != nil {
		t.Fatalf("parse jwks: %v", err)
	}
	if _, ok := keys["ext-kid"].(*ecdsa.PublicKey); !ok {
		t.Fatalf("expected ec public key, got %T", keys["ext-kid"])
	}
	if _, err := parseSubjectJWKS([]byte(`{"keys":[{"kty":"oct","kid":"h1","k":"c2VjcmV0"}]}`)); err == nil {
		t.Fatal("symmetric-only jwks must be rejected")
	}
	if _, err := parseSubjectJWKS([]byte(`{"keys":[]}`)); err == nil {
		t.Fatal("empty jwks must be rejected")
	}
}

func TestSubjectKeyCacheRefreshesWhenTrustURLChanges(t *testing.T) {
	key := federationKey(t)
	cache := newSubjectKeyCache()
	fetches := 0
	cache.fetch = func(_ context.Context, _ string) ([]byte, error) {
		fetches++
		return federationJWKS(t, key, "ext-kid"), nil
	}
	issuer := &SubjectIssuer{ID: "si1", JWKSURL: "https://login.hooli.example/keys-1"}
	if _, err := cache.keysFor(context.Background(), issuer); err != nil {
		t.Fatal(err)
	}
	issuer.JWKSURL = "https://login.hooli.example/keys-2"
	if _, err := cache.keysFor(context.Background(), issuer); err != nil {
		t.Fatal(err)
	}
	if fetches != 2 {
		t.Fatalf("trust URL change must refresh keys, fetches=%d", fetches)
	}
}

func TestValidateSubjectIdentifierIsFormatAgnostic(t *testing.T) {
	accepted := []string{
		"user_123",
		"0195f2a9-1b22-7c3d-9e4f-5a6b7c8d9e0f",
		"richard.hendricks@piedpiper.example",
		"auth0|507f1f77bcf86cd799439011",
		"oidc:google-oauth2:114379862390123456789",
		"21034658712345678901",
		"https://login.hooli.example/users/richard",
		"arn:aws:sts::123456789012:assumed-role/PiperNet/richard",
		"ríchárd-陳大文-Ричард",
		"x",
		"id with internal spaces",
		strings.Repeat("a", subjectIDMaxBytes),
	}
	for _, sub := range accepted {
		if err := validateSubjectIdentifier(sub); err != nil {
			t.Fatalf("legitimate identifier %q rejected: %v", sub, err)
		}
	}

	rejected := []struct {
		name string
		sub  string
	}{
		{"empty", ""},
		{"over length", strings.Repeat("a", subjectIDMaxBytes+1)},
		{"newline", "user\n123"},
		{"carriage return", "user\r123"},
		{"nul byte", "user\x00123"},
		{"ansi escape", "user\x1b[31m123"},
		{"leading whitespace", " user123"},
		{"trailing whitespace", "user123\t"},
		{"bidi override", "user\u202E123"},
		{"bidi isolate", "user\u2066123"},
		{"replacement char", "user\uFFFD123"},
		{"invalid utf8", "user\xff\xfe123"},
	}
	for _, tc := range rejected {
		if err := validateSubjectIdentifier(tc.sub); err == nil {
			t.Fatalf("%s must be rejected", tc.name)
		}
	}
}

func TestFederateSubjectMintsUserAuthorityRecord(t *testing.T) {
	db := trustedIssuerDB(t)
	key := federationKey(t)
	srv := federationServer(t, db, federationJWKS(t, key, "ext-kid"))
	resp, challenge, code, apiErr := srv.exchange(context.Background(), federationRequest(federationIDToken(t, key, "ext-kid", nil)), "req-fed-1")
	if apiErr != nil || challenge != nil || code != http.StatusOK {
		t.Fatalf("federation failed: code=%d err=%v", code, apiErr)
	}
	claims, err := srv.validateSubjectToken(context.Background(), resp.AccessToken, "zone1")
	if err != nil {
		t.Fatalf("minted token must be a valid session mandate: %v", err)
	}
	if claimString(claims, "sub") != "user_123" || claimString(claims, "sub_type") != SubTypeUser {
		t.Fatalf("expected user_123/user, got %s/%s", claimString(claims, "sub"), claimString(claims, "sub_type"))
	}
	if claimString(claims, "scope") != "" {
		t.Fatalf("federated session must carry no scopes, got %q", claimString(claims, "scope"))
	}
	if len(db.insertedAuthorityRecords) != 1 {
		t.Fatalf("expected one session insert, got %d", len(db.insertedAuthorityRecords))
	}
	sess := db.insertedAuthorityRecords[0]
	if sess.SessionType != "user" || sess.SubjectID == nil || *sess.SubjectID != "user_123" {
		t.Fatalf("session row not user-typed for the federated sub: %+v", sess)
	}
	if !strings.Contains(string(sess.ClaimsJSON), federationIssuer) {
		t.Fatalf("session must record issuer provenance, got %q", sess.ClaimsJSON)
	}
}

func TestFederateSubjectDenies(t *testing.T) {
	key := federationKey(t)
	jwks := federationJWKS(t, key, "ext-kid")
	otherKey := federationKey(t)

	cases := []struct {
		name   string
		db     *stubDB
		jwks   []byte
		token  string
		mutate func(*TokenExchangeRequest)
		code   int
	}{
		{"untrusted issuer", exchangeFlowDB(t), jwks, federationIDToken(t, key, "ext-kid", nil), nil, http.StatusUnauthorized},
		{"wrong audience", trustedIssuerDB(t), jwks, federationIDToken(t, key, "ext-kid", func(c jwt.MapClaims) { c["aud"] = "other-api" }), nil, http.StatusUnauthorized},
		{"wrong signature", trustedIssuerDB(t), jwks, federationIDToken(t, otherKey, "ext-kid", nil), nil, http.StatusUnauthorized},
		{"missing sub", trustedIssuerDB(t), jwks, federationIDToken(t, key, "ext-kid", func(c jwt.MapClaims) { c["sub"] = "" }), nil, http.StatusUnauthorized},
		{"hostile sub", trustedIssuerDB(t), jwks, federationIDToken(t, key, "ext-kid", func(c jwt.MapClaims) { c["sub"] = "user\n123" }), nil, http.StatusUnauthorized},
		{"expired", trustedIssuerDB(t), jwks, federationIDToken(t, key, "ext-kid", func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Hour).Unix() }), nil, http.StatusUnauthorized},
		{"jwks unavailable", trustedIssuerDB(t), nil, federationIDToken(t, key, "ext-kid", nil), nil, http.StatusUnauthorized},
		{"resources forbidden", trustedIssuerDB(t), jwks, federationIDToken(t, key, "ext-kid", nil), func(r *TokenExchangeRequest) { r.Resources = []string{"resource://pipernet"} }, http.StatusBadRequest},
		{"scope forbidden", trustedIssuerDB(t), jwks, federationIDToken(t, key, "ext-kid", nil), func(r *TokenExchangeRequest) { r.Scope = "pipernet:read" }, http.StatusBadRequest},
		{"delegation forbidden", trustedIssuerDB(t), jwks, federationIDToken(t, key, "ext-kid", nil), func(r *TokenExchangeRequest) { r.DelegationEdgeID = "edge1" }, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := federationServer(t, tc.db, tc.jwks)
			req := federationRequest(tc.token)
			if tc.mutate != nil {
				tc.mutate(&req)
			}
			_, challenge, code, apiErr := srv.exchange(context.Background(), req, "req-fed-deny")
			if apiErr == nil || challenge != nil || code != tc.code {
				t.Fatalf("expected deny code=%d, got code=%d err=%v", tc.code, code, apiErr)
			}
		})
	}
}

func TestFederatedAuthorityRecordCannotMintResources(t *testing.T) {
	db := trustedIssuerDB(t)
	key := federationKey(t)
	srv := federationServer(t, db, federationJWKS(t, key, "ext-kid"))
	resp, _, code, apiErr := srv.exchange(context.Background(), federationRequest(federationIDToken(t, key, "ext-kid", nil)), "req-fed-2")
	if apiErr != nil || code != http.StatusOK {
		t.Fatalf("federation failed: code=%d err=%v", code, apiErr)
	}
	// A federated user session presented as subject_token must not open a direct
	// resource mint: resource exchanges are Gateway-only, and the platform contract
	// has no allow rule for a subject-bearing exchange without a Delegation.
	sessRow := db.insertedAuthorityRecords[0]
	db.session = &AuthorityRecord{ID: sessRow.ID, ZoneID: "zone1", Status: "active", ExpiresAt: time.Now().Add(time.Hour), SubjectID: sessRow.SubjectID}
	direct := TokenExchangeRequest{
		GrantType:     "urn:ietf:params:oauth:grant-type:token-exchange",
		SubjectToken:  resp.AccessToken,
		Resources:     []string{"resource://pipernet"},
		Scope:         "pipernet:read",
		ZoneID:        "zone1",
		ApplicationID: "app1",
		ClientSecret:  "piper-secret",
	}
	_, _, code, apiErr = srv.exchange(context.Background(), direct, "req-fed-3")
	if apiErr == nil || code == http.StatusOK {
		t.Fatalf("direct resource mint from a federated session must be denied, got code=%d", code)
	}
	if apiErr != nil && !strings.Contains(strings.ToLower(apiErr.Error()), "gateway") && code != http.StatusForbidden {
		t.Fatalf("expected gateway-only or policy denial, got %v", apiErr)
	}
}
