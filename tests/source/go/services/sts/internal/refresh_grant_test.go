// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Brokered grant refresh and provider service token path tests.

package internal

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
)

func expiredGrant(t *testing.T, providerID string) *ProviderGrant {
	t.Helper()
	refreshCt, err := sealZEK(exchangeFlowZEK(), []byte("refresh-token"))
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Minute)
	return &ProviderGrant{
		ID:             "grant-1",
		ZoneID:         "z1",
		UserID:         "user-1",
		ResourceID:     "res1",
		ProviderID:     &providerID,
		AccessTokenCt:  []byte("stale"),
		RefreshTokenCt: refreshCt,
		ExpiresAt:      &past,
	}
}

func oauthProvider(config string, secret []byte, nonce []byte) *ProviderConfig {
	return &ProviderConfig{
		ID:                "provider1",
		ProviderKind:      strPtr("oauth2_authorization_code"),
		ConfigJSON:        []byte(config),
		SecretConfigCt:    secret,
		SecretConfigNonce: nonce,
	}
}

func TestTryRefreshBrokeredGrantShortCircuits(t *testing.T) {
	providerID := "provider1"
	srv := refreshTestServer(&stubDB{grantErr: errors.New("no grant")}, newMemSTSRedis())
	if got := srv.tryRefreshBrokeredGrant(context.Background(), "z1", "", "res1", &providerID); got != nil {
		t.Fatalf("empty user must skip refresh, got %#v", got)
	}
	if got := srv.tryRefreshBrokeredGrant(context.Background(), "z1", "user-1", "res1", &providerID); got != nil {
		t.Fatalf("missing grant must not block the exchange, got %#v", got)
	}

	future := time.Now().Add(time.Hour)
	fresh := expiredGrant(t, providerID)
	fresh.ExpiresAt = &future
	srv = refreshTestServer(&stubDB{grant: fresh}, newMemSTSRedis())
	if got := srv.tryRefreshBrokeredGrant(context.Background(), "z1", "user-1", "res1", &providerID); got != nil {
		t.Fatalf("unexpired grant must skip refresh, got %#v", got)
	}

	dead := expiredGrant(t, providerID)
	dead.RefreshTokenCt = nil
	srv = refreshTestServer(&stubDB{grant: dead}, newMemSTSRedis())
	got := srv.tryRefreshBrokeredGrant(context.Background(), "z1", "user-1", "res1", &providerID)
	if got == nil || got.Code != sharederr.CredentialExpired {
		t.Fatalf("non-renewable grant must expire, got %#v", got)
	}
}

func TestRefreshExpiredBrokeredGrantTaxonomy(t *testing.T) {
	providerID := "provider1"
	zek := exchangeFlowZEK()
	goodSecretCt, goodSecretNonce := testProviderSecret(t, zek, `{"client_secret":"hooli-secret"}`)

	run := func(t *testing.T, db *stubDB) *sharederr.CaracalError {
		t.Helper()
		srv := refreshTestServer(db, newMemSTSRedis())
		return srv.refreshExpiredBrokeredGrant(context.Background(), "z1", "user-1", "res1", &providerID)
	}

	t.Run("grant lookup failure is silent", func(t *testing.T) {
		if got := run(t, &stubDB{grantErr: errors.New("no grant")}); got != nil {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("provider missing", func(t *testing.T) {
		got := run(t, &stubDB{grant: expiredGrant(t, providerID)})
		if got == nil || got.Code != sharederr.CredentialExpired {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("provider kind not refreshable", func(t *testing.T) {
		db := &stubDB{grant: expiredGrant(t, providerID), provider: &ProviderConfig{ID: providerID, ProviderKind: strPtr("api_key")}}
		got := run(t, db)
		if got == nil || got.Code != sharederr.CredentialExpired {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("provider config malformed", func(t *testing.T) {
		db := &stubDB{grant: expiredGrant(t, providerID), provider: oauthProvider(`{broken`, goodSecretCt, goodSecretNonce)}
		got := run(t, db)
		if got == nil || got.Code != sharederr.CredentialExpired {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("provider config incomplete", func(t *testing.T) {
		db := &stubDB{grant: expiredGrant(t, providerID), provider: oauthProvider(`{"token_endpoint":"https://login.hooli.example/token"}`, goodSecretCt, goodSecretNonce)}
		got := run(t, db)
		if got == nil || got.Code != sharederr.CredentialExpired {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("secret decrypt failure", func(t *testing.T) {
		provider := oauthProvider(`{"token_endpoint":"https://login.hooli.example/token","client_id":"cid"}`, []byte("garbage"), make([]byte, 12))
		db := &stubDB{grant: expiredGrant(t, providerID), provider: provider}
		got := run(t, db)
		if got == nil || got.Code != sharederr.CredentialExpired {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("endpoint scheme rejected", func(t *testing.T) {
		provider := oauthProvider(`{"token_endpoint":"http://login.hooli.example/token","client_id":"cid"}`, goodSecretCt, goodSecretNonce)
		db := &stubDB{grant: expiredGrant(t, providerID), provider: provider}
		got := run(t, db)
		if got == nil || !strings.Contains(got.Description, "endpoint not allowed") {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("endpoint without allowlist rejected", func(t *testing.T) {
		provider := oauthProvider(`{"token_endpoint":"https://login.hooli.example/token","client_id":"cid"}`, goodSecretCt, goodSecretNonce)
		db := &stubDB{grant: expiredGrant(t, providerID), provider: provider}
		got := run(t, db)
		if got == nil || !strings.Contains(got.Description, "endpoint not allowed") {
			t.Fatalf("got %#v", got)
		}
	})
}

func TestProviderServiceTokenKinds(t *testing.T) {
	zek := exchangeFlowZEK()
	sealed := func(config string) ([]byte, []byte) {
		return testProviderSecret(t, zek, config)
	}
	provider := func(kind, config string, secretCt, secretNonce []byte) *ProviderConfig {
		return &ProviderConfig{
			ID:                "provider1",
			ProviderKind:      strPtr(kind),
			ConfigJSON:        []byte(config),
			SecretConfigCt:    secretCt,
			SecretConfigNonce: secretNonce,
		}
	}
	srv := refreshTestServer(&stubDB{}, nil)

	apiCt, apiNonce := sealed(`{"api_key":"pipernet-api-key"}`)
	if token, err := srv.providerServiceToken(context.Background(), provider("api_key", `{}`, apiCt, apiNonce)); err != nil || token != "pipernet-api-key" {
		t.Fatalf("api key token=%q err=%v", token, err)
	}
	emptyCt, emptyNonce := sealed(`{}`)
	if _, err := srv.providerServiceToken(context.Background(), provider("api_key", `{}`, emptyCt, emptyNonce)); err == nil {
		t.Fatal("missing api key must fail")
	}
	bearerCt, bearerNonce := sealed(`{"bearer_token":"pipernet-bearer"}`)
	if token, err := srv.providerServiceToken(context.Background(), provider("bearer_token", `{}`, bearerCt, bearerNonce)); err != nil || token != "pipernet-bearer" {
		t.Fatalf("bearer token=%q err=%v", token, err)
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("bearer_token", `{}`, emptyCt, emptyNonce)); err == nil {
		t.Fatal("missing bearer token must fail")
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("none", `{}`, emptyCt, emptyNonce)); err == nil {
		t.Fatal("unsupported provider kind must fail")
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("api_key", `{}`, []byte("garbage"), make([]byte, 12))); err == nil {
		t.Fatal("undecryptable secret must fail")
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("oauth2_client_credentials", `{broken`, emptyCt, emptyNonce)); err == nil {
		t.Fatal("malformed oauth2 config must fail")
	}
	if _, err := srv.providerServiceToken(context.Background(), provider("oauth2_client_credentials", `{"token_endpoint":"","client_id":""}`, emptyCt, emptyNonce)); err == nil {
		t.Fatal("incomplete oauth2 config must fail")
	}

	oauthConfig := `{"token_endpoint":"http://login.hooli.example/token","client_id":"cid"}`
	oauth := provider("oauth2_client_credentials", oauthConfig, emptyCt, emptyNonce)
	if _, err := srv.providerServiceToken(context.Background(), oauth); err == nil {
		t.Fatal("non-https oauth2 endpoint must fail the fetch")
	}
	srv.storeProviderServiceToken(oauth.ID, providerServiceTokenFingerprint(oauth), "cached-token", time.Now().Add(time.Hour))
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
	if providerServiceTokenFingerprint(distinct) == providerServiceTokenFingerprint(other) {
		t.Fatal("config changes must change the fingerprint")
	}
}
