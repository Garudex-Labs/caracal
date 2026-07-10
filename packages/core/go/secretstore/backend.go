// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The SecretBackend read surface for the Go data plane: every provider credential read goes through this interface.

package secretstore

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Backend resolves opaque secret values addressed by hierarchical refs. The data
// plane only reads, so external backend credentials issued to Go services can be
// scoped read-only; all writes happen in the control plane.
type Backend interface {
	Kind() string
	Get(ctx context.Context, ref string) (value []byte, found bool, err error)
}

// Kinds accepted by CARACAL_SECRET_BACKEND. The builtin backend is constructed by
// the owning service because it is bound to that service's database pool.
const (
	KindBuiltin           = "builtin"
	KindVault             = "vault"
	KindInfisical         = "infisical"
	KindAzureKeyVault     = "azurekeyvault"
	KindAWSSecretsManager = "awssecretsmanager"
	KindGCPSecretManager  = "gcpsecretmanager"
	KindCustom            = "custom"
)

// KindFromEnv resolves the configured backend kind, defaulting to builtin.
func KindFromEnv(raw string) (string, error) {
	kind := strings.ToLower(strings.TrimSpace(raw))
	if kind == "" {
		return KindBuiltin, nil
	}
	switch kind {
	case KindBuiltin, KindVault, KindInfisical, KindAzureKeyVault, KindAWSSecretsManager, KindGCPSecretManager, KindCustom:
		return kind, nil
	default:
		return "", fmt.Errorf("CARACAL_SECRET_BACKEND must be one of builtin, vault, infisical, azurekeyvault, awssecretsmanager, gcpsecretmanager, custom; got %q", kind)
	}
}

// ProviderSecretConfigRef addresses a provider's sealed credential document.
func ProviderSecretConfigRef(zoneID, providerID string) string {
	return "zones/" + zoneID + "/providers/" + providerID + "/secretConfig"
}

// AAD strings for machine-generated runtime material sealed with the builtin
// envelope in its owning table. Fixed per column family so control-plane row
// rewrites and data-plane reads agree; these must match the TypeScript constants.
const (
	AADConnectionAccessToken  = "caracal/providerConnections/accessToken"
	AADConnectionRefreshToken = "caracal/providerConnections/refreshToken"
	AADZoneSigningKey         = "caracal/secrets/zoneSigningKey"
)

type cacheEntry struct {
	value     []byte
	found     bool
	expiresAt time.Time
}

// A stale entry may still be served for this long when the backend errors, so a
// short external outage does not stop token exchange; rotation converges as soon
// as the backend answers again.
const maxStaleOnError = 10 * time.Minute

type cachedBackend struct {
	inner Backend
	ttl   time.Duration
	mu    sync.RWMutex
	byRef map[string]cacheEntry
}

// NewCached bounds external backend read traffic with a short in-memory TTL, so hot
// token-exchange paths do not turn every mint into a network round trip. Credential
// rotation propagates within one TTL. Entries hold whatever the inner backend
// stores; behind the Opened wrapper that is sealed envelopes, never plaintext.
func NewCached(inner Backend, ttl time.Duration) Backend {
	return &cachedBackend{inner: inner, ttl: ttl, byRef: make(map[string]cacheEntry)}
}

func (c *cachedBackend) Kind() string { return c.inner.Kind() }

func (c *cachedBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	c.mu.RLock()
	entry, ok := c.byRef[ref]
	c.mu.RUnlock()
	now := time.Now()
	if ok && now.Before(entry.expiresAt) {
		return entry.value, entry.found, nil
	}
	value, found, err := c.inner.Get(ctx, ref)
	if err != nil {
		if ok && now.Before(entry.expiresAt.Add(maxStaleOnError)) {
			return entry.value, entry.found, nil
		}
		return nil, false, err
	}
	c.mu.Lock()
	c.byRef[ref] = cacheEntry{value: value, found: found, expiresAt: now.Add(c.ttl)}
	c.mu.Unlock()
	return value, found, nil
}

type openedBackend struct {
	inner   Backend
	keyring *Keyring
}

// Opened is the crypto boundary of the data plane read path: every stored value
// is a CSS1 envelope sealed with the ref as AAD, so backends and caches beneath
// this wrapper only ever carry ciphertext.
func Opened(inner Backend, keyring *Keyring) Backend {
	return &openedBackend{inner: inner, keyring: keyring}
}

func (o *openedBackend) Kind() string { return o.inner.Kind() }

func (o *openedBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	envelope, found, err := o.inner.Get(ctx, ref)
	if err != nil || !found {
		return nil, found, err
	}
	value, err := o.keyring.Open(envelope, ref)
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}
