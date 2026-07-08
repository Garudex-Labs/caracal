// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Provider service token tests: kind handling, caching, and TTL bounds.

package internal

import (
	"context"
	"errors"
	"testing"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
)

func TestRefreshExpiredBrokeredGrantShortCircuits(t *testing.T) {
	providerID := "provider-1"

	missing := refreshTestServer(&grantDB{grantErr: errors.New("no grant")}, nil)
	if got := missing.refreshExpiredProviderConnection(context.Background(), "z", "user-1", &providerID); got != nil {
		t.Fatalf("missing grant must be silent, got %#v", got)
	}

	future := time.Now().Add(time.Hour)
	fresh := refreshTestServer(&grantDB{grant: &ProviderConnection{ID: "grant-1", ExpiresAt: &future}}, nil)
	if got := fresh.refreshExpiredProviderConnection(context.Background(), "z", "user-1", &providerID); got != nil {
		t.Fatalf("peer-refreshed grant must be silent, got %#v", got)
	}

	dead := refreshTestServer(&grantDB{grant: expiredGrant(nil, &providerID)}, nil)
	got := dead.refreshExpiredProviderConnection(context.Background(), "z", "user-1", &providerID)
	if got == nil || got.Code != sharederr.CredentialExpired {
		t.Fatalf("non-renewable grant must expire, got %#v", got)
	}
}

func TestProviderServiceTokenKinds(t *testing.T) {
	zek := make([]byte, 32)
	for i := range zek {
		zek[i] = byte(i + 1)
	}
	provider := func(id, kind, config string) *ProviderConfig {
		return &ProviderConfig{
			ID:           id,
			ProviderKind: strPtr(kind),
			ConfigJSON:   []byte(config),
		}
	}
	store := map[string][]byte{}
	for id, secret := range map[string]string{
		"provider-api":    `{"api_key":"pipernet-api-key"}`,
		"provider-bearer": `{"bearer_token":"pipernet-bearer"}`,
		"provider-empty":  `{}`,
	} {
		for ref, envelope := range testProviderSecret(t, zek, id, secret) {
			store[ref] = envelope
		}
	}
	store[secretstore.ProviderSecretConfigRef("", "provider-garbage")] = []byte("garbage")
	srv := refreshTestServer(&stubDB{storeEnvelopes: store}, nil)

	if token, err := srv.providerServiceToken(context.Background(), provider("provider-api", "api_key", `{}`)); err != nil || token != "pipernet-api-key" {
		t.Fatalf("api key token=%q err=%v", token, err)
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("provider-empty", "api_key", `{}`)); err == nil {
		t.Fatal("missing api key must fail")
	}
	if token, err := srv.providerServiceToken(context.Background(), provider("provider-bearer", "bearer_token", `{}`)); err != nil || token != "pipernet-bearer" {
		t.Fatalf("bearer token=%q err=%v", token, err)
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("provider-empty", "bearer_token", `{}`)); err == nil {
		t.Fatal("missing bearer token must fail")
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("provider-empty", "none", `{}`)); err == nil {
		t.Fatal("unsupported provider kind must fail")
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("provider-garbage", "api_key", `{}`)); err == nil {
		t.Fatal("undecryptable secret must fail")
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("provider-empty", "oauth2_client_credentials", `{broken`)); err == nil {
		t.Fatal("malformed oauth2 config must fail")
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("provider-empty", "oauth2_client_credentials", `{"token_endpoint":"","client_id":""}`)); err == nil {
		t.Fatal("incomplete oauth2 config must fail")
	}

	oauthConfig := `{"token_endpoint":"http://login.hooli.example/token","client_id":"cid"}`
	oauth := provider("provider1", "oauth2_client_credentials", oauthConfig)
	if _, err := srv.providerServiceToken(context.Background(), oauth); err == nil {
		t.Fatal("non-https oauth2 endpoint must fail the fetch")
	}
	srv.storeProviderServiceToken(oauth.ID, providerServiceTokenFingerprint(oauth, ""), "cached-token", time.Now().Add(time.Hour))
	if token, err := srv.providerServiceToken(context.Background(), oauth); err != nil || token != "cached-token" {
		t.Fatalf("cached token=%q err=%v", token, err)
	}
}

func TestProviderServiceTokenTTLBounds(t *testing.T) {
	if got := providerServiceTokenTTL(0, 0); got != 3600*time.Second {
		t.Fatalf("default ttl = %v", got)
	}
	if got := providerServiceTokenTTL(7200, 3600); got != 3600*time.Second {
		t.Fatalf("capped ttl = %v", got)
	}
	if got := providerServiceTokenTTL(120, 3600); got != 120*time.Second {
		t.Fatalf("provider ttl = %v", got)
	}
}

func TestCachedProviderServiceTokenWindow(t *testing.T) {
	srv := refreshTestServer(&stubDB{}, nil)
	now := time.Now()

	srv.storeProviderServiceToken("provider1", "fp-1", "token-1", now.Add(time.Second))
	if _, ok := srv.cachedProviderServiceToken("provider1", "fp-1", now); ok {
		t.Fatal("token expiring within the cache skew must not be stored")
	}

	srv.storeProviderServiceToken("provider1", "fp-1", "token-1", now.Add(time.Hour))
	if token, ok := srv.cachedProviderServiceToken("provider1", "fp-1", now); !ok || token != "token-1" {
		t.Fatalf("cache hit token=%q ok=%v", token, ok)
	}
	if _, ok := srv.cachedProviderServiceToken("provider1", "fp-other", now); ok {
		t.Fatal("fingerprint mismatch must miss the cache")
	}
	if _, ok := srv.cachedProviderServiceToken("provider1", "fp-1", now.Add(2*time.Hour)); ok {
		t.Fatal("expired entry must miss the cache")
	}
	if _, ok := srv.cachedProviderServiceToken("unknown", "fp-1", now); ok {
		t.Fatal("unknown provider must miss the cache")
	}

	distinct := &ProviderConfig{ID: "provider1", ProviderKind: strPtr("oauth2_client_credentials"), ConfigJSON: []byte(`{"a":1}`)}
	other := &ProviderConfig{ID: "provider1", ProviderKind: strPtr("oauth2_client_credentials"), ConfigJSON: []byte(`{"a":2}`)}
	if providerServiceTokenFingerprint(distinct, "") == providerServiceTokenFingerprint(other, "") {
		t.Fatal("config changes must change the fingerprint")
	}
}
