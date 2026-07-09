// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the data-plane secret backend wiring: builtin reads, metering, and external backend construction.

package internal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
)

func secretBackendKeyring(t *testing.T) *secretstore.Keyring {
	t.Helper()
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = byte(i*7 + 3)
	}
	keyring, err := secretstore.NewKeyring(kek)
	if err != nil {
		t.Fatal(err)
	}
	return keyring
}

func TestNewSecretBackendBuiltin(t *testing.T) {
	keyring := secretBackendKeyring(t)
	ref := secretstore.ProviderSecretConfigRef("z1", "p1")
	envelope, err := keyring.Seal([]byte(`{"api_key":"k"}`), ref)
	if err != nil {
		t.Fatal(err)
	}
	db := &stubDB{storeEnvelopes: map[string][]byte{ref: envelope}}
	metrics := &STSMetrics{}
	backend, err := newSecretBackend(secretstore.KindBuiltin, db, keyring, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if backend.Kind() != secretstore.KindBuiltin {
		t.Errorf("kind = %q", backend.Kind())
	}
	value, found, err := backend.Get(context.Background(), ref)
	if err != nil || !found || string(value) != `{"api_key":"k"}` {
		t.Fatalf("get: %q %v %v", value, found, err)
	}
	if _, found, err := backend.Get(context.Background(), "zones/z1/providers/gone/secretConfig"); found || err != nil {
		t.Fatalf("missing ref must not error: %v %v", found, err)
	}
	if reads := metrics.SecretBackendReads.Load(); reads != 2 {
		t.Errorf("reads counter = %d, want 2", reads)
	}
	if failures := metrics.SecretBackendErrors.Load(); failures != 0 {
		t.Errorf("errors counter = %d, want 0", failures)
	}
}

type failingSecretDB struct {
	*stubDB
}

func (f *failingSecretDB) GetSecretStoreEnvelope(_ context.Context, _ string) ([]byte, error) {
	return nil, errors.New("connection reset")
}

func TestNewSecretBackendBuiltinMetersFailures(t *testing.T) {
	keyring := secretBackendKeyring(t)
	metrics := &STSMetrics{}
	backend, err := newSecretBackend(secretstore.KindBuiltin, &failingSecretDB{stubDB: &stubDB{}}, keyring, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := backend.Get(context.Background(), "zones/z1/providers/p1/secretConfig"); err == nil {
		t.Fatal("database failures must propagate")
	}
	if failures := metrics.SecretBackendErrors.Load(); failures != 1 {
		t.Errorf("errors counter = %d, want 1", failures)
	}
	if reads := metrics.SecretBackendReads.Load(); reads != 1 {
		t.Errorf("reads counter = %d, want 1", reads)
	}
}

func TestNewSecretBackendExternal(t *testing.T) {
	keyring := secretBackendKeyring(t)
	ref := secretstore.ProviderSecretConfigRef("z1", "p1")
	envelope, err := keyring.Seal([]byte("external-secret"), ref)
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/secrets/"+ref {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write(envelope)
	}))
	defer server.Close()
	t.Setenv("CARACAL_CUSTOM_SECRETS_URL", server.URL)
	t.Setenv("CARACAL_CUSTOM_SECRETS_TOKEN", "tok")
	metrics := &STSMetrics{}
	backend, err := newSecretBackend(secretstore.KindCustom, &stubDB{}, keyring, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if backend.Kind() != secretstore.KindCustom {
		t.Errorf("kind = %q", backend.Kind())
	}
	for i := 0; i < 2; i++ {
		value, found, err := backend.Get(context.Background(), ref)
		if err != nil || !found || string(value) != "external-secret" {
			t.Fatalf("get %d: %q %v %v", i, value, found, err)
		}
	}
	if requests != 1 {
		t.Errorf("external reads must be cached, got %d upstream requests", requests)
	}
	if reads := metrics.SecretBackendReads.Load(); reads != 2 {
		t.Errorf("reads counter = %d, want 2", reads)
	}
}

func TestNewSecretBackendRejectsMisconfiguredExternal(t *testing.T) {
	t.Setenv("CARACAL_CUSTOM_SECRETS_URL", "")
	t.Setenv("CARACAL_CUSTOM_SECRETS_TOKEN", "")
	if _, err := newSecretBackend(secretstore.KindCustom, &stubDB{}, secretBackendKeyring(t), &STSMetrics{}); err == nil {
		t.Error("a misconfigured external backend must fail construction")
	}
}
