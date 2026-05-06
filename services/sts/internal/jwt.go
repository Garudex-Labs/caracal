// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JWT signing (ES256) and JWKS construction for STS-issued tokens.

package internal

import (
	"context"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"sync"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/shared/crypto"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const dekCacheTTL = 15 * time.Minute

type zoneCacheEntry struct {
	key       *ecdsa.PrivateKey
	kid       string
	expiresAt time.Time
}

// KeyCache holds decrypted zone signing keys in memory with a 15-minute TTL.
type KeyCache struct {
	mu      sync.RWMutex
	entries map[string]*zoneCacheEntry
	db      DBQuerier
	zek     []byte
}

func newKeyCache(db DBQuerier, zek []byte) *KeyCache {
	return &KeyCache{entries: make(map[string]*zoneCacheEntry), db: db, zek: zek}
}

func (k *KeyCache) getKeyAndKid(ctx context.Context, zoneID string) (*ecdsa.PrivateKey, string, error) {
	k.mu.RLock()
	e, ok := k.entries[zoneID]
	k.mu.RUnlock()
	if ok && time.Now().Before(e.expiresAt) {
		return e.key, e.kid, nil
	}

	secret, err := k.db.GetZoneSigningKeySecret(ctx, zoneID)
	if err != nil {
		return nil, "", fmt.Errorf("load signing key for zone %s: %w", zoneID, err)
	}

	keyBytes, err := sharedcrypto.Open(k.zek, secret.Nonce, secret.Ciphertext)
	if err != nil {
		return nil, "", fmt.Errorf("decrypt signing key: %w", err)
	}

	priv, err := jwt.ParseECPrivateKeyFromPEM(keyBytes)
	if err != nil {
		return nil, "", fmt.Errorf("parse signing key: %w", err)
	}

	k.mu.Lock()
	k.entries[zoneID] = &zoneCacheEntry{key: priv, kid: secret.ID, expiresAt: time.Now().Add(dekCacheTTL)}
	k.mu.Unlock()
	return priv, secret.ID, nil
}

func (k *KeyCache) getKey(ctx context.Context, zoneID string) (*ecdsa.PrivateKey, error) {
	priv, _, err := k.getKeyAndKid(ctx, zoneID)
	return priv, err
}

func (k *KeyCache) getPublicKeyAndKid(ctx context.Context, zoneID string) (*ecdsa.PublicKey, string, error) {
	priv, kid, err := k.getKeyAndKid(ctx, zoneID)
	if err != nil {
		return nil, "", err
	}
	return &priv.PublicKey, kid, nil
}

func (k *KeyCache) Invalidate(zoneID string) {
	k.mu.Lock()
	delete(k.entries, zoneID)
	k.mu.Unlock()
}

// Claims is the full Caracal JWT claim set.
type Claims struct {
	jwt.RegisteredClaims
	ZoneID           string   `json:"zone_id"`
	ClientID         string   `json:"client_id"`
	Scope            string   `json:"scope,omitempty"`
	SID              string   `json:"sid"`
	Target           []string `json:"target,omitempty"`
	OnBehalf         string   `json:"on_behalf,omitempty"`
	DelegationEdgeID string   `json:"delegation_edge_id,omitempty"`
	SourceSessionID  string   `json:"source_session_id,omitempty"`
	TargetSessionID  string   `json:"target_session_id,omitempty"`
	DelegationPath   []string `json:"delegation_path,omitempty"`
	GraphEpoch       int64    `json:"delegation_graph_epoch,omitempty"`
}

// IssueParams holds everything needed to produce a signed JWT.
type IssueParams struct {
	ZoneID           string
	AppID            string
	SubjectID        string
	SID              string
	Scopes           string
	Resources        []string
	TTL              time.Duration
	OnBehalfOf       string
	DelegationEdgeID string
	SourceSessionID  string
	TargetSessionID  string
	DelegationPath   []string
	GraphEpoch       int64
}

func issueToken(ctx context.Context, params IssueParams, keys *KeyCache, issuerURL string) (string, error) {
	key, kid, err := keys.getKeyAndKid(ctx, params.ZoneID)
	if err != nil {
		return "", err
	}

	now := time.Now()
	jti, _ := uuid.NewV7()
	audience := append([]string{issuerURL}, params.Resources...)
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuerURL,
			Subject:   params.SubjectID,
			Audience:  audience,
			ExpiresAt: jwt.NewNumericDate(now.Add(params.TTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        jti.String(),
		},
		ZoneID:           params.ZoneID,
		ClientID:         params.AppID,
		Scope:            params.Scopes,
		SID:              params.SID,
		Target:           params.Resources,
		OnBehalf:         params.OnBehalfOf,
		DelegationEdgeID: params.DelegationEdgeID,
		SourceSessionID:  params.SourceSessionID,
		TargetSessionID:  params.TargetSessionID,
		DelegationPath:   params.DelegationPath,
		GraphEpoch:       params.GraphEpoch,
	}

	t := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	if kid != "" {
		t.Header["kid"] = kid
	}
	return t.SignedString(key)
}

// JWKSKey is a single key in a JWKS document.
type JWKSKey struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Use string `json:"use"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// BuildJWKS returns the serialized JWKS JSON for one or more zone public keys.
// Multiple keys are served during the 24h rotation grace period.
func BuildJWKS(keys []JWKSEntry) ([]byte, error) {
	jwksKeys := make([]JWKSKey, len(keys))
	for i, e := range keys {
		jwksKeys[i] = JWKSKey{
			Kty: "EC", Crv: "P-256", Use: "sig",
			Kid: e.Kid, Alg: "ES256",
			X: b64URLUint(e.Pub.X),
			Y: b64URLUint(e.Pub.Y),
		}
	}
	return json.Marshal(map[string]interface{}{"keys": jwksKeys})
}

// JWKSEntry pairs a public key with its key ID for JWKS construction.
type JWKSEntry struct {
	Pub *ecdsa.PublicKey
	Kid string
}

func b64URLUint(n *big.Int) string {
	b := n.Bytes()
	padded := make([]byte, 32)
	copy(padded[32-len(b):], b)
	return base64.RawURLEncoding.EncodeToString(padded)
}
