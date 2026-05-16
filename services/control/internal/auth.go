// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Bearer-token authenticator: validates STS-issued ES256 JWTs and asserts the control:invoke scope.

package internal

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/garudex-labs/caracal/core/scope"
	"github.com/garudex-labs/caracal/identity"
	"github.com/golang-jwt/jwt/v5"
)

const requiredScope = "control:invoke"

type Authenticator struct {
	jwksURL  string
	keys     map[string]*ecdsa.PublicKey
	mu       sync.RWMutex
	httpc    *http.Client
	lastLoad time.Time
}

type Claims struct {
	jwt.RegisteredClaims
	Scope string `json:"scope"`
}

func NewAuthenticator(ctx context.Context) (*Authenticator, error) {
	url := os.Getenv("STS_JWKS_URL")
	if url == "" {
		return nil, errors.New("STS_JWKS_URL not set")
	}
	a := &Authenticator{
		jwksURL: url,
		keys:    map[string]*ecdsa.PublicKey{},
		httpc:   &http.Client{Timeout: 5 * time.Second},
	}
	if err := a.refresh(ctx); err != nil {
		return nil, fmt.Errorf("jwks load: %w", err)
	}
	return a, nil
}

// Verify parses bearer, validates signature against the JWKS, and asserts the required scope.
// Returns the claims on success or an error describing the rejection reason.
func (a *Authenticator) Verify(ctx context.Context, header string) (*Claims, error) {
	bearer := strings.TrimPrefix(header, "Bearer ")
	if bearer == header || bearer == "" {
		return nil, errors.New("missing bearer token")
	}
	claims := &Claims{}
	tok, err := jwt.ParseWithClaims(bearer, claims, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodES256.Alg() {
			return nil, fmt.Errorf("unexpected alg %s", t.Method.Alg())
		}
		kid, _ := t.Header["kid"].(string)
		if k := a.lookup(kid); k != nil {
			return k, nil
		}
		if err := a.refresh(ctx); err != nil {
			return nil, fmt.Errorf("jwks refresh: %w", err)
		}
		if k := a.lookup(kid); k != nil {
			return k, nil
		}
		return nil, fmt.Errorf("unknown kid %s", kid)
	})
	if err != nil || !tok.Valid {
		return nil, fmt.Errorf("invalid token: %w", err)
	}
	if !scope.Has(claims.Scope, requiredScope) {
		return nil, fmt.Errorf("missing scope %q", requiredScope)
	}
	return claims, nil
}

func (a *Authenticator) lookup(kid string) *ecdsa.PublicKey {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.keys[kid]
}

func (a *Authenticator) refresh(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.lastLoad.IsZero() && time.Since(a.lastLoad) < 30*time.Second {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.jwksURL, nil)
	if err != nil {
		return err
	}
	resp, err := a.httpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks status %d", resp.StatusCode)
	}
	var jwks struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return err
	}
	for _, raw := range jwks.Keys {
		key, kid, err := identity.ParseECJWK(raw)
		if err != nil {
			continue
		}
		a.keys[kid] = key
	}
	a.lastLoad = time.Now()
	return nil
}
