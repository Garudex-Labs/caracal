// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JWKS fetcher with 5-min in-memory cache.

package identity

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"
)

const (
	jwksTTL          = 5 * time.Minute
	jwksFetchTimeout = 10 * time.Second
)

type jwksEntry struct {
	keys      map[string]any
	fetchedAt time.Time
}

var (
	jwksMu     sync.RWMutex
	jwksCache  = map[string]*jwksEntry{}
	jwksClient = &http.Client{Timeout: jwksFetchTimeout}
)

// GetJWKS returns the cached key set for issuer, fetching if missing or stale.
func GetJWKS(issuer string) (map[string]any, error) {
	return GetJWKSContext(context.Background(), issuer)
}

// GetJWKSContext is GetJWKS with caller-supplied cancellation.
func GetJWKSContext(ctx context.Context, issuer string) (map[string]any, error) {
	url := issuer + "/.well-known/jwks.json"

	jwksMu.RLock()
	entry, ok := jwksCache[issuer]
	jwksMu.RUnlock()
	if ok && time.Since(entry.fetchedAt) < jwksTTL {
		return entry.keys, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := jwksClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks fetch %d", resp.StatusCode)
	}

	var body struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}

	keys := make(map[string]any, len(body.Keys))
	for _, raw := range body.Keys {
		key, kid, err := parseJWK(raw)
		if err != nil {
			continue
		}
		keys[kid] = key
	}

	jwksMu.Lock()
	jwksCache[issuer] = &jwksEntry{keys: keys, fetchedAt: time.Now()}
	jwksMu.Unlock()
	return keys, nil
}

// ResetJWKSCache clears the in-memory JWKS cache. Intended for tests.
func ResetJWKSCache() {
	jwksMu.Lock()
	jwksCache = map[string]*jwksEntry{}
	jwksMu.Unlock()
}

func parseJWK(raw json.RawMessage) (*ecdsa.PublicKey, string, error) {
	var key struct {
		Kty string `json:"kty"`
		Crv string `json:"crv"`
		Kid string `json:"kid"`
		X   string `json:"x"`
		Y   string `json:"y"`
	}
	if err := json.Unmarshal(raw, &key); err != nil {
		return nil, "", err
	}
	if key.Kty != "EC" || key.Crv != "P-256" || key.Kid == "" {
		return nil, "", fmt.Errorf("unsupported jwk")
	}
	xBytes, err := base64.RawURLEncoding.DecodeString(key.X)
	if err != nil {
		return nil, "", err
	}
	yBytes, err := base64.RawURLEncoding.DecodeString(key.Y)
	if err != nil {
		return nil, "", err
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(xBytes), Y: new(big.Int).SetBytes(yBytes)}, key.Kid, nil
}
