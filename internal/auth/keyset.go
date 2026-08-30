// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package auth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"sync"
	"time"
)

const (
	// jwksMaxBody caps the JWKS response size; a legitimate keyset is tiny.
	jwksMaxBody = 1 << 20
	// refetchCooldown rate-limits keyset refetches triggered by unknown kids,
	// so a flood of forged tokens cannot hammer the JWKS endpoint.
	refetchCooldown = time.Minute
)

// KeySet resolves signing keys by kid from a JWKS endpoint.
//
// Keys are fetched lazily and cached. An unknown kid triggers one refetch
// (rate-limited) to pick up rotated keys without restarting.
type KeySet struct {
	url    string
	client *http.Client

	mu        sync.Mutex
	keys      map[string]crypto.PublicKey
	lastFetch time.Time
}

// NewKeySet builds a KeySet over the given JWKS URL. A nil client uses a
// 10-second-timeout default.
func NewKeySet(url string, client *http.Client) *KeySet {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &KeySet{url: url, client: client}
}

// Key returns the public key for kid, refetching the JWKS once if the kid is
// unknown and the cooldown allows.
func (ks *KeySet) Key(ctx context.Context, kid string) (crypto.PublicKey, error) {
	ks.mu.Lock()
	defer ks.mu.Unlock()

	if key, ok := ks.keys[kid]; ok {
		return key, nil
	}
	if time.Since(ks.lastFetch) < refetchCooldown {
		return nil, fmt.Errorf("unknown key id %q", kid)
	}
	if err := ks.fetchLocked(ctx); err != nil {
		return nil, fmt.Errorf("fetch jwks: %w", err)
	}
	if key, ok := ks.keys[kid]; ok {
		return key, nil
	}
	return nil, fmt.Errorf("unknown key id %q", kid)
}

func (ks *KeySet) fetchLocked(ctx context.Context) error {
	ks.lastFetch = time.Now()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ks.url, nil)
	if err != nil {
		return err
	}
	resp, err := ks.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks endpoint returned %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, jwksMaxBody))
	if err != nil {
		return err
	}

	keys, err := parseJWKS(body)
	if err != nil {
		return err
	}
	ks.keys = keys
	return nil
}

type jwk struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Kid string `json:"kid"`
	X   string `json:"x"`
	Y   string `json:"y"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func parseJWKS(data []byte) (map[string]crypto.PublicKey, error) {
	var doc struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parse jwks document: %w", err)
	}
	keys := make(map[string]crypto.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kid == "" {
			continue
		}
		key, err := k.publicKey()
		if err != nil {
			return nil, fmt.Errorf("jwk %q: %w", k.Kid, err)
		}
		keys[k.Kid] = key
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("jwks document contains no usable keys")
	}
	return keys, nil
}

func (k jwk) publicKey() (crypto.PublicKey, error) {
	switch k.Kty {
	case "EC":
		if k.Crv != "P-256" {
			return nil, fmt.Errorf("unsupported curve %q", k.Crv)
		}
		x, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil {
			return nil, fmt.Errorf("decode x: %w", err)
		}
		y, err := base64.RawURLEncoding.DecodeString(k.Y)
		if err != nil {
			return nil, fmt.Errorf("decode y: %w", err)
		}
		pub := &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(x),
			Y:     new(big.Int).SetBytes(y),
		}
		if !pub.IsOnCurve(pub.X, pub.Y) {
			return nil, fmt.Errorf("point is not on P-256")
		}
		return pub, nil
	case "RSA":
		n, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			return nil, fmt.Errorf("decode n: %w", err)
		}
		e, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil {
			return nil, fmt.Errorf("decode e: %w", err)
		}
		exp := new(big.Int).SetBytes(e)
		if !exp.IsInt64() || exp.Int64() < 3 || exp.Int64() > 1<<31-1 {
			return nil, fmt.Errorf("implausible RSA exponent")
		}
		modulus := new(big.Int).SetBytes(n)
		if modulus.BitLen() < 2048 {
			return nil, fmt.Errorf("RSA modulus below 2048 bits")
		}
		return &rsa.PublicKey{N: modulus, E: int(exp.Int64())}, nil
	default:
		return nil, fmt.Errorf("unsupported key type %q", k.Kty)
	}
}
