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

type cachedBackend struct {
	inner Backend
	ttl   time.Duration
	mu    sync.RWMutex
	byRef map[string]cacheEntry
}

// NewCached bounds external backend read traffic with a short in-memory TTL, so hot
// token-exchange paths do not turn every mint into a network round trip. Credential
// rotation propagates within one TTL.
func NewCached(inner Backend, ttl time.Duration) Backend {
	return &cachedBackend{inner: inner, ttl: ttl, byRef: make(map[string]cacheEntry)}
}

func (c *cachedBackend) Kind() string { return c.inner.Kind() }

func (c *cachedBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	c.mu.RLock()
	entry, ok := c.byRef[ref]
	c.mu.RUnlock()
	if ok && time.Now().Before(entry.expiresAt) {
		return entry.value, entry.found, nil
	}
	value, found, err := c.inner.Get(ctx, ref)
	if err != nil {
		return nil, false, err
	}
	c.mu.Lock()
	c.byRef[ref] = cacheEntry{value: value, found: found, expiresAt: time.Now().Add(c.ttl)}
	c.mu.Unlock()
	return value, found, nil
}
