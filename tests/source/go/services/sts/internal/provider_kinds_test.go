// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for http_basic provider directives and RFC 7523 jwt_bearer assertion signing.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
)

func TestBuildUpstreamDirectiveSupportsHTTPBasicProvider(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("http_basic"),
			ConfigJSON:   []byte(`{"username":"richard"}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"password":"piper-pass"}`),
	}, zek)
	directive, err := srv.buildUpstreamDirective(context.Background(), "zone1", map[string]any{"sub": "user1"}, resource, true, false)
	if err != nil {
		t.Fatalf("gateway directive should support http_basic provider shape: %v", err)
	}
	expected := base64.StdEncoding.EncodeToString([]byte("richard:piper-pass"))
	if directive.AuthMode != UpstreamAuthProviderOAuth || directive.AuthHeader != "Authorization" || directive.AuthScheme != "Basic" || directive.ProviderToken != expected {
		t.Fatalf("unexpected http_basic directive: %#v", directive)
	}
}

func TestBuildUpstreamDirectiveRejectsHTTPBasicRuntimeInjection(t *testing.T) {
	providerID := "provider1"
	upstreamURL := "https://upstream.example"
	resource := &Resource{
		ID:                   "res1",
		Identifier:           "resource://api",
		UpstreamURL:          &upstreamURL,
		CredentialProviderID: &providerID,
	}
	zek := []byte("12345678901234567890123456789012")
	srv := providerServer(&stubDB{
		provider: &ProviderConfig{
			ID:           providerID,
			ProviderKind: strPtr("http_basic"),
			ConfigJSON:   []byte(`{"username":"richard","allow_runtime_injection":true}`),
		},
		storeEnvelopes: testProviderSecret(t, zek, providerID, `{"password":"piper-pass"}`),
	}, zek)
	if _, err := srv.buildUpstreamDirective(context.Background(), "zone1", nil, resource, true, true); err == nil {
		t.Fatal("http_basic must never be eligible for runtime credential injection")
	}
}

func TestExchangeSurfacesProviderCredentialFailure(t *testing.T) {
	providerID := "provider1"
	db := exchangeFlowDB(t)
	db.resource.CredentialProviderID = &providerID
	db.provider = &ProviderConfig{
		ID:           providerID,
		ProviderKind: strPtr("oauth2_client_credentials"),
		ConfigJSON:   []byte(`{"token_endpoint":"https://issuer.example/token","client_id":"hooli-client","allowed_token_hosts":["issuer.example"]}`),
	}
	db.storeEnvelopes = testProviderSecret(t, exchangeFlowZEK(), providerID, `{}`)
	db.session = activeUserAuthorityRecord("sess-1")
	srv := exchangeFlowServer(t, db, runCredentialAllowPolicy)
	req := baseExchangeRequest()
	req.ClientSecret = ""
	req.GatewayAuthenticated = true
	req.SubjectToken = gatewayMandate(t, srv, "user-1", "sess-1", "pipernet:read")

	_, _, code, apiErr := srv.exchange(context.Background(), req, "req-1")
	if code != http.StatusBadGateway || apiErr == nil || apiErr.Code != sharederr.HTTPRequestFailed {
		t.Fatalf("code=%d err=%#v", code, apiErr)
	}
	if !strings.Contains(apiErr.Description, "resource://pipernet") || !strings.Contains(apiErr.Description, "provider token endpoint") {
		t.Fatalf("description must carry the resource and reason: %s", apiErr.Description)
	}
	audited := false
	for {
		select {
		case event := <-srv.auditBuffer.ch:
			if event.Decision == "deny" && event.EvaluationStatus == "provider_credential_unavailable" {
				audited = true
			}
		default:
		}
		if audited || len(srv.auditBuffer.ch) == 0 {
			break
		}
	}
	if !audited {
		t.Fatal("provider credential failure must be audited as a deny")
	}
}

func TestBuildProviderGrantAssertionClaims(t *testing.T) {
	pemKey := ecKeyPEM(t, elliptic.P256())
	cfg := oauthClientCredentialsConfig{
		ClientID: "agent@project.iam.gserviceaccount.example",
		KeyID:    "kid-1",
		Scopes:   []string{"https://www.googleapis.example/auth/cloud-platform"},
	}
	signed, err := buildProviderGrantAssertion(cfg, pemKey, "https://oauth2.googleapis.example/token", time.Now().UTC())
	if err != nil {
		t.Fatalf("grant assertion: %v", err)
	}
	token, _, err := jwt.NewParser().ParseUnverified(signed, jwt.MapClaims{})
	if err != nil {
		t.Fatalf("parse assertion: %v", err)
	}
	claims := token.Claims.(jwt.MapClaims)
	if claims["iss"] != cfg.ClientID || claims["sub"] != cfg.ClientID {
		t.Fatalf("iss/sub must default to the client id: %#v", claims)
	}
	if claims["aud"] != "https://oauth2.googleapis.example/token" {
		t.Fatalf("aud must default to the token endpoint: %#v", claims)
	}
	if claims["scope"] != "https://www.googleapis.example/auth/cloud-platform" {
		t.Fatalf("scopes must ride inside the assertion scope claim: %#v", claims)
	}
	if token.Header["kid"] != "kid-1" {
		t.Fatalf("kid header missing: %#v", token.Header)
	}

	cfg.AssertionSubject = "monica.hall@piedpiper.example"
	cfg.AssertionAudience = "https://login.salesforce.example"
	signed, err = buildProviderGrantAssertion(cfg, pemKey, "https://oauth2.googleapis.example/token", time.Now().UTC())
	if err != nil {
		t.Fatalf("grant assertion with overrides: %v", err)
	}
	token, _, err = jwt.NewParser().ParseUnverified(signed, jwt.MapClaims{})
	if err != nil {
		t.Fatalf("parse assertion: %v", err)
	}
	claims = token.Claims.(jwt.MapClaims)
	if claims["sub"] != "monica.hall@piedpiper.example" || claims["aud"] != "https://login.salesforce.example" {
		t.Fatalf("assertion overrides must win: %#v", claims)
	}
}

func TestResourceMintScopesDerivesLifecycleForGatewayRouted(t *testing.T) {
	upstream := "https://api.pipernet.example"
	routed := &Resource{Identifier: "resource://pipernet", UpstreamURL: &upstream, Scopes: []string{"data:read"}}
	if !scopesAllowed([]string{"agent:lifecycle"}, resourceMintScopes(routed)) {
		t.Fatal("gateway-routed resources must accept the lifecycle bootstrap scope without declaring it")
	}
	if !scopesAllowed([]string{"data:read"}, resourceMintScopes(routed)) {
		t.Fatal("declared business scopes must stay mintable")
	}
	if scopesAllowed([]string{"data:write"}, resourceMintScopes(routed)) {
		t.Fatal("undeclared business scopes must stay denied")
	}

	declared := &Resource{Identifier: "resource://pipernet", UpstreamURL: &upstream, Scopes: []string{"data:read", "agent:lifecycle"}}
	if got := resourceMintScopes(declared); len(got) != 2 {
		t.Fatalf("a declared lifecycle scope must not duplicate: %v", got)
	}

	unrouted := &Resource{Identifier: "resource://pipernet", Scopes: []string{"data:read"}}
	if scopesAllowed([]string{"agent:lifecycle"}, resourceMintScopes(unrouted)) {
		t.Fatal("resources without an upstream must not accept the lifecycle scope implicitly")
	}
}

func testCertificatePEM(t *testing.T, key *ecdsa.PrivateKey) string {
	t.Helper()
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "caracal-provider-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestBuildProviderClientAssertionCertificateThumbprints(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	certPEM := testCertificatePEM(t, key)

	signed, err := buildProviderClientAssertion("https://login.hooli.example/oauth/token", "client-1", "", pemKey, certPEM, time.Now().UTC())
	if err != nil {
		t.Fatalf("client assertion: %v", err)
	}
	token, _, err := jwt.NewParser().ParseUnverified(signed, jwt.MapClaims{})
	if err != nil {
		t.Fatalf("parse assertion: %v", err)
	}
	block, _ := pem.Decode([]byte(certPEM))
	sum1 := sha1.Sum(block.Bytes)
	sum256 := sha256.Sum256(block.Bytes)
	if token.Header["x5t"] != base64.RawURLEncoding.EncodeToString(sum1[:]) {
		t.Fatalf("x5t header mismatch: %#v", token.Header)
	}
	if token.Header["x5t#S256"] != base64.RawURLEncoding.EncodeToString(sum256[:]) {
		t.Fatalf("x5t#S256 header mismatch: %#v", token.Header)
	}

	if _, err := buildProviderClientAssertion("https://login.hooli.example/oauth/token", "client-1", "", pemKey, "not pem", time.Now().UTC()); err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("malformed certificate must fail assertion signing, got %v", err)
	}
}

func brokeredGrantServer(grant *ProviderConnection, kind string) (*Server, *stubDB) {
	db := &stubDB{
		grant:    grant,
		provider: &ProviderConfig{ID: "provider1", ProviderKind: strPtr(kind), ConfigJSON: []byte(`{}`)},
		now:      time.Now(),
	}
	return &Server{db: db}, db
}

func TestTryRefreshBrokeredGrantServesNonExpiringTokens(t *testing.T) {
	providerID := "provider1"
	srv, db := brokeredGrantServer(&ProviderConnection{ID: "grant1", ProviderID: &providerID, AccessTokenCt: []byte("ct")}, "oauth2_authorization_code")
	if rerr := srv.tryRefreshProviderConnection(context.Background(), "zone1", "user1", &providerID); rerr != nil {
		t.Fatalf("a grant without an expiry is non-expiring and must be served: %v", rerr)
	}
	if len(db.markedExpired) != 0 {
		t.Fatalf("non-expiring grant must not be marked expired: %v", db.markedExpired)
	}
}

func TestTryRefreshBrokeredGrantMarksDeadGrantsExpired(t *testing.T) {
	providerID := "provider1"
	expired := time.Now().Add(-time.Minute)
	srv, db := brokeredGrantServer(&ProviderConnection{ID: "grant1", ProviderID: &providerID, AccessTokenCt: []byte("ct"), ExpiresAt: &expired}, "oauth2_authorization_code")
	rerr := srv.tryRefreshProviderConnection(context.Background(), "zone1", "user1", &providerID)
	if rerr == nil || rerr.Description != "credential_expired_not_renewable" {
		t.Fatalf("expired grant without a refresh token must deny as not renewable, got %v", rerr)
	}
	if len(db.markedExpired) != 1 || db.markedExpired[0] != "grant1" {
		t.Fatalf("dead grant must transition to expired status: %v", db.markedExpired)
	}
}

func TestTryRefreshBrokeredGrantSkewBoundary(t *testing.T) {
	providerID := "provider1"
	// The stub's provider kind check inside the refresh path fails fast, so a returned
	// error proves the skew window triggered a refresh attempt without any network.
	nearExpiry := time.Now().Add(10 * time.Second)
	srv, _ := brokeredGrantServer(&ProviderConnection{ID: "grant1", ProviderID: &providerID, AccessTokenCt: []byte("ct"), RefreshTokenCt: []byte("rt"), ExpiresAt: &nearExpiry}, "bearer_token")
	if rerr := srv.tryRefreshProviderConnection(context.Background(), "zone1", "user1", &providerID); rerr == nil {
		t.Fatal("a renewable grant inside the refresh skew must attempt a refresh")
	}

	freshExpiry := time.Now().Add(5 * time.Minute)
	srv, _ = brokeredGrantServer(&ProviderConnection{ID: "grant1", ProviderID: &providerID, AccessTokenCt: []byte("ct"), RefreshTokenCt: []byte("rt"), ExpiresAt: &freshExpiry}, "bearer_token")
	if rerr := srv.tryRefreshProviderConnection(context.Background(), "zone1", "user1", &providerID); rerr != nil {
		t.Fatalf("a grant beyond the refresh skew must be served without refresh: %v", rerr)
	}
}
