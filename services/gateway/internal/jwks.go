// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Per-zone JWKS cache and ES256 bearer signature verification against STS public keys.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

const (
	jwksTTL          = 5 * time.Minute
	jwksMissCooldown = 30 * time.Second
	jwksBodyLimit    = 256 * 1024
)

// jwksKey mirrors a single entry in an STS JWKS document.
type jwksKey struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

type jwksDoc struct {
	Keys []jwksKey `json:"keys"`
}

type zoneKeys struct {
	keys      map[string]*ecdsa.PublicKey
	fetchedAt time.Time
}

// jwksCache holds per-zone public keys fetched from STS /.well-known/jwks.json.
// Entries refresh on TTL expiry, and on a kid miss the cache forces one refetch
// (rate-limited by jwksMissCooldown) so a freshly rotated kid is picked up
// without waiting for the next periodic refresh.
type jwksCache struct {
	stsURL   string
	client   *http.Client
	log      zerolog.Logger
	mu       sync.Mutex
	zones    map[string]*zoneKeys
	lastMiss map[string]time.Time
}

func newJWKSCache(stsURL string, timeout time.Duration, log zerolog.Logger) *jwksCache {
	return &jwksCache{
		stsURL:   strings.TrimRight(stsURL, "/"),
		client:   &http.Client{Timeout: timeout},
		log:      log,
		zones:    map[string]*zoneKeys{},
		lastMiss: map[string]time.Time{},
	}
}

// Verify parses an ES256 JWS, looks up the public key for (zoneID, kid), and
// validates the signature. It does not enforce claim semantics — only that the
// token is signed by the zone whose binding the gateway resolved. A nil cache
// is a no-op so tests that fabricate unsigned tokens can drive the proxy.
func (c *jwksCache) Verify(ctx context.Context, zoneID, token string) error {
	if c == nil {
		return nil
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fmt.Errorf("malformed jws")
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return fmt.Errorf("decode header: %w", err)
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(headerJSON, &hdr); err != nil {
		return fmt.Errorf("parse header: %w", err)
	}
	if hdr.Alg != "ES256" {
		return fmt.Errorf("unsupported alg %q", hdr.Alg)
	}
	if hdr.Kid == "" {
		return fmt.Errorf("missing kid")
	}
	pub, err := c.lookup(ctx, zoneID, hdr.Kid)
	if err != nil {
		return err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}
	if len(sig) != 64 {
		return fmt.Errorf("invalid signature length")
	}
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	signed := []byte(parts[0] + "." + parts[1])
	digest := sha256.Sum256(signed)
	if !ecdsa.Verify(pub, digest[:], r, s) {
		return fmt.Errorf("signature mismatch")
	}
	return nil
}

func (c *jwksCache) lookup(ctx context.Context, zoneID, kid string) (*ecdsa.PublicKey, error) {
	if pub := c.cached(zoneID, kid); pub != nil {
		return pub, nil
	}
	if err := c.refresh(ctx, zoneID, false); err != nil {
		return nil, err
	}
	if pub := c.cached(zoneID, kid); pub != nil {
		return pub, nil
	}
	if err := c.refresh(ctx, zoneID, true); err != nil {
		return nil, err
	}
	if pub := c.cached(zoneID, kid); pub != nil {
		return pub, nil
	}
	return nil, fmt.Errorf("kid %q not in jwks for zone %s", kid, zoneID)
}

func (c *jwksCache) cached(zoneID, kid string) *ecdsa.PublicKey {
	c.mu.Lock()
	defer c.mu.Unlock()
	z, ok := c.zones[zoneID]
	if !ok {
		return nil
	}
	if time.Since(z.fetchedAt) >= jwksTTL {
		return nil
	}
	return z.keys[kid]
}

func (c *jwksCache) refresh(ctx context.Context, zoneID string, forceMiss bool) error {
	c.mu.Lock()
	z, ok := c.zones[zoneID]
	if ok && time.Since(z.fetchedAt) < jwksTTL && !forceMiss {
		c.mu.Unlock()
		return nil
	}
	if forceMiss {
		if last, seen := c.lastMiss[zoneID]; seen && time.Since(last) < jwksMissCooldown {
			c.mu.Unlock()
			return fmt.Errorf("jwks miss cooldown for zone %s", zoneID)
		}
		c.lastMiss[zoneID] = time.Now()
	}
	c.mu.Unlock()

	keys, err := c.fetch(ctx, zoneID)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.zones[zoneID] = &zoneKeys{keys: keys, fetchedAt: time.Now()}
	c.mu.Unlock()
	return nil
}

func (c *jwksCache) fetch(ctx context.Context, zoneID string) (map[string]*ecdsa.PublicKey, error) {
	url := c.stsURL + "/.well-known/jwks.json?zone_id=" + zoneID
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jwks fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks fetch status %d", resp.StatusCode)
	}
	var doc jwksDoc
	if err := json.NewDecoder(io.LimitReader(resp.Body, jwksBodyLimit)).Decode(&doc); err != nil {
		return nil, fmt.Errorf("jwks decode: %w", err)
	}
	out := make(map[string]*ecdsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kty != "EC" || k.Crv != "P-256" || k.Alg != "ES256" || k.Kid == "" {
			continue
		}
		x, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil {
			continue
		}
		y, err := base64.RawURLEncoding.DecodeString(k.Y)
		if err != nil {
			continue
		}
		pub := &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(x),
			Y:     new(big.Int).SetBytes(y),
		}
		out[k.Kid] = pub
	}
	if len(out) == 0 {
		return nil, errors.New("jwks: no usable keys")
	}
	return out, nil
}
