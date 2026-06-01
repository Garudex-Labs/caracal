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
	"net"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"
)

const (
	jwksTTL          = 5 * time.Minute
	jwksFetchTimeout = 10 * time.Second
)

type jwksEntry struct {
	keys      map[string]*ecdsa.PublicKey
	fetchedAt time.Time
}

var (
	jwksMu     sync.RWMutex
	jwksCache  = map[string]*jwksEntry{}
	jwksClient = &http.Client{Timeout: jwksFetchTimeout}
)

// GetJWKS returns the cached key set for issuer, fetching if missing or stale.
func GetJWKS(issuer string) (map[string]*ecdsa.PublicKey, error) {
	return GetJWKSContext(context.Background(), issuer)
}

// GetJWKSContext is GetJWKS with caller-supplied cancellation.
func GetJWKSContext(ctx context.Context, issuer string) (map[string]*ecdsa.PublicKey, error) {
	if err := assertSecureIssuer(issuer); err != nil {
		return nil, err
	}
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

	keys := make(map[string]*ecdsa.PublicKey, len(body.Keys))
	for _, raw := range body.Keys {
		key, kid, err := ParseECJWK(raw)
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

// assertSecureIssuer requires the issuer to use https. http is permitted only for
// loopback hosts, or for any host when CARACAL_ALLOW_INSECURE_CONFIG_URLS=true, so
// local development and trusted-network deployments are not blocked.
func assertSecureIssuer(issuer string) error {
	parsed, err := url.Parse(issuer)
	if err != nil {
		return fmt.Errorf("invalid issuer url: %w", err)
	}
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		if isLoopbackHost(parsed.Hostname()) || os.Getenv("CARACAL_ALLOW_INSECURE_CONFIG_URLS") == "true" {
			return nil
		}
		return fmt.Errorf("insecure issuer scheme: http requires a loopback host or CARACAL_ALLOW_INSECURE_CONFIG_URLS=true")
	default:
		return fmt.Errorf("unsupported issuer scheme: %q", parsed.Scheme)
	}
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ParseECJWK decodes a single EC P-256 JWK (RFC 7517) and returns the public key together
// with its key id. Returns an error when the key type, curve, or kid is missing/unsupported,
// or when the X/Y coordinates fail base64url decoding.
func ParseECJWK(raw json.RawMessage) (*ecdsa.PublicKey, string, error) {
	var key struct {
		Kty    string   `json:"kty"`
		Crv    string   `json:"crv"`
		Kid    string   `json:"kid"`
		Alg    string   `json:"alg"`
		Use    string   `json:"use"`
		KeyOps []string `json:"key_ops"`
		X      string   `json:"x"`
		Y      string   `json:"y"`
	}
	if err := json.Unmarshal(raw, &key); err != nil {
		return nil, "", err
	}
	if key.Kty != "EC" || key.Crv != "P-256" || key.Kid == "" || key.Alg != "ES256" || (key.Use != "" && key.Use != "sig") {
		return nil, "", fmt.Errorf("unsupported jwk")
	}
	if len(key.KeyOps) > 0 && !containsKeyOp(key.KeyOps, "verify") {
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
	if len(xBytes) != 32 || len(yBytes) != 32 {
		return nil, "", fmt.Errorf("invalid jwk coordinates")
	}
	curve := elliptic.P256()
	x := new(big.Int).SetBytes(xBytes)
	y := new(big.Int).SetBytes(yBytes)
	if !curve.IsOnCurve(x, y) {
		return nil, "", fmt.Errorf("invalid jwk point")
	}
	return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, key.Kid, nil
}

func containsKeyOp(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
