// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for secret backend selection, refs, caching, and the external HTTP backends.

package secretstore

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestKindFromEnv(t *testing.T) {
	cases := []struct {
		raw     string
		want    string
		wantErr bool
	}{
		{"", KindBuiltin, false},
		{"  ", KindBuiltin, false},
		{"builtin", KindBuiltin, false},
		{"VAULT", KindVault, false},
		{" infisical ", KindInfisical, false},
		{"azurekeyvault", KindAzureKeyVault, false},
		{"awssecretsmanager", KindAWSSecretsManager, false},
		{"gcpsecretmanager", KindGCPSecretManager, false},
		{"custom", KindCustom, false},
		{"consul", "", true},
	}
	for _, tc := range cases {
		kind, err := KindFromEnv(tc.raw)
		if tc.wantErr {
			if err == nil {
				t.Errorf("KindFromEnv(%q): want error", tc.raw)
			}
			continue
		}
		if err != nil || kind != tc.want {
			t.Errorf("KindFromEnv(%q) = %q, %v; want %q", tc.raw, kind, err, tc.want)
		}
	}
}

func TestProviderSecretConfigRef(t *testing.T) {
	got := ProviderSecretConfigRef("zone-1", "provider-9")
	if got != "zones/zone-1/providers/provider-9/secretConfig" {
		t.Errorf("unexpected ref %q", got)
	}
}

func TestFromEnvRejectsBuiltinAndUnknown(t *testing.T) {
	if _, err := FromEnv(KindBuiltin); err == nil {
		t.Error("builtin must not be constructible through FromEnv")
	}
	if _, err := FromEnv("consul"); err == nil {
		t.Error("unknown kinds must be rejected")
	}
}

func TestFromEnvRequiresBackendConfig(t *testing.T) {
	for _, env := range []string{
		"CARACAL_VAULT_ADDR", "CARACAL_VAULT_TOKEN",
		"CARACAL_INFISICAL_URL", "CARACAL_INFISICAL_TOKEN", "CARACAL_INFISICAL_PROJECT_ID",
		"CARACAL_AZURE_VAULT_URL", "CARACAL_AZURE_TENANT_ID", "CARACAL_AZURE_CLIENT_ID", "CARACAL_AZURE_CLIENT_SECRET",
		"CARACAL_AWS_REGION", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
		"CARACAL_GCP_PROJECT", "CARACAL_GCP_CREDENTIALS_FILE", "GOOGLE_APPLICATION_CREDENTIALS",
		"CARACAL_CUSTOM_SECRETS_URL", "CARACAL_CUSTOM_SECRETS_TOKEN",
	} {
		t.Setenv(env, "")
	}
	for _, kind := range []string{KindVault, KindInfisical, KindAzureKeyVault, KindAWSSecretsManager, KindGCPSecretManager, KindCustom} {
		if _, err := FromEnv(kind); err == nil {
			t.Errorf("FromEnv(%q) with empty configuration must fail", kind)
		}
	}
}

type countingBackend struct {
	kind  string
	value []byte
	found bool
	err   error
	calls int
}

func (c *countingBackend) Kind() string { return c.kind }

func (c *countingBackend) Get(_ context.Context, _ string) ([]byte, bool, error) {
	c.calls++
	return c.value, c.found, c.err
}

func TestCachedBackendServesFromCache(t *testing.T) {
	inner := &countingBackend{kind: KindVault, value: []byte("v"), found: true}
	cached := NewCached(inner, time.Minute)
	if cached.Kind() != KindVault {
		t.Errorf("cached backend must report the inner kind")
	}
	for i := 0; i < 3; i++ {
		value, found, err := cached.Get(context.Background(), "ref-1")
		if err != nil || !found || string(value) != "v" {
			t.Fatalf("get %d: %q %v %v", i, value, found, err)
		}
	}
	if inner.calls != 1 {
		t.Errorf("want one upstream read, got %d", inner.calls)
	}
}

func TestCachedBackendCachesNotFound(t *testing.T) {
	inner := &countingBackend{kind: KindVault}
	cached := NewCached(inner, time.Minute)
	for i := 0; i < 2; i++ {
		if _, found, err := cached.Get(context.Background(), "missing"); found || err != nil {
			t.Fatalf("get %d: %v %v", i, found, err)
		}
	}
	if inner.calls != 1 {
		t.Errorf("want one upstream read for cached miss, got %d", inner.calls)
	}
}

func TestCachedBackendDoesNotCacheErrors(t *testing.T) {
	inner := &countingBackend{kind: KindVault, err: errors.New("down")}
	cached := NewCached(inner, time.Minute)
	for i := 0; i < 2; i++ {
		if _, _, err := cached.Get(context.Background(), "ref"); err == nil {
			t.Fatal("want error passthrough")
		}
	}
	if inner.calls != 2 {
		t.Errorf("errors must not be cached, got %d calls", inner.calls)
	}
}

func TestCachedBackendServesStaleOnError(t *testing.T) {
	inner := &countingBackend{kind: KindVault, value: []byte("v"), found: true}
	cached := NewCached(inner, time.Nanosecond)
	if _, _, err := cached.Get(context.Background(), "ref"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Millisecond)
	inner.err = errors.New("down")
	value, found, err := cached.Get(context.Background(), "ref")
	if err != nil || !found || string(value) != "v" {
		t.Fatalf("expired entry must be served while the backend errors: %q %v %v", value, found, err)
	}
	if inner.calls != 2 {
		t.Errorf("stale serve must still attempt the upstream read, got %d calls", inner.calls)
	}
}

func TestOpenedBackendUnsealsEnvelopes(t *testing.T) {
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = byte(i*3 + 1)
	}
	ring, err := NewKeyring(kek)
	if err != nil {
		t.Fatal(err)
	}
	ref := ProviderSecretConfigRef("z1", "p1")
	envelope, err := ring.Seal([]byte(`{"api_key":"k"}`), ref)
	if err != nil {
		t.Fatal(err)
	}
	inner := &countingBackend{kind: KindVault, value: envelope, found: true}
	opened := Opened(inner, ring)
	if opened.Kind() != KindVault {
		t.Errorf("opened backend must report the inner kind")
	}
	value, found, err := opened.Get(context.Background(), ref)
	if err != nil || !found || string(value) != `{"api_key":"k"}` {
		t.Fatalf("get: %q %v %v", value, found, err)
	}
	if _, _, err := Opened(inner, ring).Get(context.Background(), "zones/z1/providers/other/secretConfig"); err == nil {
		t.Error("an envelope served for the wrong ref must fail authentication")
	}
	missing := &countingBackend{kind: KindVault}
	if _, found, err := Opened(missing, ring).Get(context.Background(), ref); found || err != nil {
		t.Fatalf("missing ref must pass through: %v %v", found, err)
	}
}

func TestCachedBackendExpires(t *testing.T) {
	inner := &countingBackend{kind: KindVault, value: []byte("v"), found: true}
	cached := NewCached(inner, time.Nanosecond)
	if _, _, err := cached.Get(context.Background(), "ref"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Millisecond)
	if _, _, err := cached.Get(context.Background(), "ref"); err != nil {
		t.Fatal(err)
	}
	if inner.calls != 2 {
		t.Errorf("expired entries must re-read upstream, got %d calls", inner.calls)
	}
}

func TestVaultBackendGet(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("vault-secret"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Vault-Token") != "tok" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/v1/secret/data/zones/z1/providers/p1/secretConfig":
			w.Write([]byte(`{"data":{"data":{"value":"` + payload + `"}}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	t.Setenv("CARACAL_VAULT_ADDR", server.URL)
	t.Setenv("CARACAL_VAULT_TOKEN", "tok")
	t.Setenv("CARACAL_VAULT_MOUNT", "")
	t.Setenv("CARACAL_VAULT_NAMESPACE", "")
	backend, err := FromEnv(KindVault)
	if err != nil {
		t.Fatal(err)
	}
	value, found, err := backend.Get(context.Background(), "zones/z1/providers/p1/secretConfig")
	if err != nil || !found || string(value) != "vault-secret" {
		t.Fatalf("get: %q %v %v", value, found, err)
	}
	if _, found, err := backend.Get(context.Background(), "zones/z1/providers/gone/secretConfig"); found || err != nil {
		t.Fatalf("missing ref: %v %v", found, err)
	}
}

func TestCustomBackendGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/secrets/zones/z1/providers/p1/secretConfig":
			w.Write([]byte("raw-bytes"))
		case "/secrets/zones/z1/providers/err/secretConfig":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	t.Setenv("CARACAL_CUSTOM_SECRETS_URL", server.URL)
	t.Setenv("CARACAL_CUSTOM_SECRETS_TOKEN", "tok")
	backend, err := FromEnv(KindCustom)
	if err != nil {
		t.Fatal(err)
	}
	value, found, err := backend.Get(context.Background(), "zones/z1/providers/p1/secretConfig")
	if err != nil || !found || string(value) != "raw-bytes" {
		t.Fatalf("get: %q %v %v", value, found, err)
	}
	if _, found, err := backend.Get(context.Background(), "zones/z1/providers/gone/secretConfig"); found || err != nil {
		t.Fatalf("missing ref: %v %v", found, err)
	}
	if _, _, err := backend.Get(context.Background(), "zones/z1/providers/err/secretConfig"); err == nil {
		t.Fatal("upstream 500 must surface as an error")
	}
}
