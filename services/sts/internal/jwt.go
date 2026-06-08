// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JWT signing (ES256) and JWKS construction for STS-issued tokens.

package internal

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/packages/core/go/crypto"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const dekCacheTTL = 15 * time.Minute

type zoneCacheEntry struct {
	key       *ecdsa.PrivateKey
	kid       string
	expiresAt time.Time
}

type publicKeysCacheEntry struct {
	keys      map[string]*ecdsa.PublicKey
	expiresAt time.Time
}

// KeyCache holds decrypted zone signing keys in memory with a 15-minute TTL.
type KeyCache struct {
	mu           sync.RWMutex
	entries      map[string]*zoneCacheEntry
	pubKeysCache map[string]*publicKeysCacheEntry
	db           DBQuerier
	zek          []byte
}

func newKeyCache(db DBQuerier, zek []byte) *KeyCache {
	return &KeyCache{
		entries:      make(map[string]*zoneCacheEntry),
		pubKeysCache: make(map[string]*publicKeysCacheEntry),
		db:           db,
		zek:          zek,
	}
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
		if errors.Is(err, pgx.ErrNoRows) {
			secret, err = k.generateZoneSigningKey(ctx, zoneID)
		}
		if err != nil {
			return nil, "", fmt.Errorf("load signing key for zone %s: %w", zoneID, err)
		}
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

func (k *KeyCache) generateZoneSigningKey(ctx context.Context, zoneID string) (*SecretRow, error) {
	ciphertext, nonce, err := k.sealZoneSigningKey()
	if err != nil {
		return nil, err
	}
	return k.db.EnsureZoneSigningKeySecret(ctx, zoneID, ciphertext, nonce)
}

func (k *KeyCache) RotateZoneSigningKey(ctx context.Context, zoneID string) (*SecretRow, error) {
	if zoneID == "" {
		return nil, errors.New("zone_id required")
	}
	ciphertext, nonce, err := k.sealZoneSigningKey()
	if err != nil {
		return nil, err
	}
	secret, err := k.db.InsertZoneSigningKeySecret(ctx, zoneID, ciphertext, nonce)
	if err != nil {
		return nil, err
	}
	k.Invalidate(zoneID)
	return secret, nil
}

func (k *KeyCache) sealZoneSigningKey() ([]byte, []byte, error) {
	priv, err := sharedcrypto.GenerateP256Key()
	if err != nil {
		return nil, nil, fmt.Errorf("generate signing key: %w", err)
	}
	der, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal signing key: %w", err)
	}
	keyBytes := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	if len(keyBytes) == 0 {
		return nil, nil, fmt.Errorf("encode signing key")
	}
	ciphertext, nonce, err := sharedcrypto.Seal(k.zek, keyBytes)
	if err != nil {
		return nil, nil, fmt.Errorf("seal signing key: %w", err)
	}
	return ciphertext, nonce, nil
}

func (k *KeyCache) getPublicKeyAndKid(ctx context.Context, zoneID string) (*ecdsa.PublicKey, string, error) {
	priv, kid, err := k.getKeyAndKid(ctx, zoneID)
	if err != nil {
		return nil, "", err
	}
	return &priv.PublicKey, kid, nil
}

// getPublicKeysByZone returns all active and grace-period public keys for a zone,
// keyed by kid. Used by validateSubjectToken to verify tokens signed by any key
// in the current rotation window (active + previous key during 24h grace period).
func (k *KeyCache) getPublicKeysByZone(ctx context.Context, zoneID string) (map[string]*ecdsa.PublicKey, error) {
	k.mu.RLock()
	e, ok := k.pubKeysCache[zoneID]
	k.mu.RUnlock()
	if ok && time.Now().Before(e.expiresAt) {
		return e.keys, nil
	}

	secrets, err := k.db.GetZoneSigningKeySecrets(ctx, zoneID)
	if err != nil {
		return nil, fmt.Errorf("load zone signing keys for %s: %w", zoneID, err)
	}
	if len(secrets) == 0 {
		return nil, fmt.Errorf("no signing keys for zone %s", zoneID)
	}
	keys := make(map[string]*ecdsa.PublicKey, len(secrets))
	var decryptFailedKids []string
	var parseFailedKids []string
	for _, secret := range secrets {
		keyBytes, err := sharedcrypto.Open(k.zek, secret.Nonce, secret.Ciphertext)
		if err != nil {
			decryptFailedKids = append(decryptFailedKids, secret.ID)
			continue
		}
		priv, err := jwt.ParseECPrivateKeyFromPEM(keyBytes)
		if err != nil {
			parseFailedKids = append(parseFailedKids, secret.ID)
			continue
		}
		keys[secret.ID] = &priv.PublicKey
	}

	if len(decryptFailedKids) > 0 || len(parseFailedKids) > 0 {
		return nil, fmt.Errorf(
			"load signing keys for zone %s: decryption failed for kids %v; PEM parsing failed for kids %v",
			zoneID,
			decryptFailedKids,
			parseFailedKids,
		)
	}

	k.mu.Lock()
	k.pubKeysCache[zoneID] = &publicKeysCacheEntry{keys: keys, expiresAt: time.Now().Add(dekCacheTTL)}
	k.mu.Unlock()

	return keys, nil
}

func (k *KeyCache) Invalidate(zoneID string) {
	k.mu.Lock()
	delete(k.entries, zoneID)
	delete(k.pubKeysCache, zoneID)
	k.mu.Unlock()
}

// ChainHop is a single step in the delegation chain attribution.
type ChainHop struct {
	AppID            string `json:"application_id"`
	AgentSessionID   string `json:"agent_session_id,omitempty"`
	DelegationEdgeID string `json:"delegation_edge_id,omitempty"`
}

// Mandate use classes. Session mandates represent an execution session and may be
// re-presented to STS as subject_token; resource mandates are narrowed to a specific
// resource set and must never be reused as subject_token.
const (
	UseSession  = "session"
	UseResource = "resource"
)

// Subject classes. Disambiguates whether sub identifies a human user or an
// application principal so resource servers can apply different policies without
// inferring class from claim shape.
const (
	SubTypeUser        = "user"
	SubTypeApplication = "application"
)

// Claims is the full Caracal JWT claim set.
type Claims struct {
	jwt.RegisteredClaims
	ZoneID           string     `json:"zone_id"`
	ClientID         string     `json:"client_id"`
	Scope            string     `json:"scope,omitempty"`
	SID              string     `json:"sid"`
	RootSID          string     `json:"root_sid"`
	Use              string     `json:"use"`
	SubType          string     `json:"sub_type"`
	Target           []string   `json:"target,omitempty"`
	AgentSessionID   string     `json:"agent_session_id,omitempty"`
	DelegationEdgeID string     `json:"delegation_edge_id,omitempty"`
	SourceSessionID  string     `json:"source_session_id,omitempty"`
	TargetSessionID  string     `json:"target_session_id,omitempty"`
	DelegationPath   []string   `json:"delegation_path,omitempty"`
	DelegationChain  []ChainHop `json:"delegation_chain,omitempty"`
	HopCount         int        `json:"hop_count,omitempty"`
	GraphEpoch       int64      `json:"delegation_graph_epoch,omitempty"`
}

// IssueParams holds everything needed to produce a signed JWT.
type IssueParams struct {
	ZoneID           string
	AppID            string
	SubjectID        string
	SubType          string
	Use              string
	SID              string
	RootSID          string
	Scopes           string
	Resources        []string
	TTL              time.Duration
	AgentSessionID   string
	DelegationEdgeID string
	SourceSessionID  string
	TargetSessionID  string
	DelegationPath   []string
	DelegationChain  []ChainHop
	GraphEpoch       int64
	IssuedAt         time.Time
}

func issueToken(ctx context.Context, params IssueParams, keys *KeyCache, issuerURL string) (string, string, error) {
	key, kid, err := keys.getKeyAndKid(ctx, params.ZoneID)
	if err != nil {
		return "", "", err
	}

	now := params.IssuedAt
	if now.IsZero() {
		now = time.Now()
	}
	jti, err := uuid.NewV7()
	if err != nil {
		return "", "", fmt.Errorf("generate jti: %w", err)
	}
	jtiStr := jti.String()
	use := params.Use
	if use == "" {
		use = UseResource
	}
	subType := params.SubType
	if subType == "" {
		subType = SubTypeApplication
	}
	// Audience is class-disjoint: session mandates carry only the issuer (so they
	// can be re-presented as subject_token), resource mandates carry only their
	// target resources (so they cannot bootstrap further exchanges).
	var audience []string
	if use == UseSession {
		audience = []string{issuerURL}
	} else {
		audience = append(audience, params.Resources...)
	}
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuerURL,
			Subject:   params.SubjectID,
			Audience:  audience,
			ExpiresAt: jwt.NewNumericDate(now.Add(params.TTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        jtiStr,
		},
		ZoneID:           params.ZoneID,
		ClientID:         params.AppID,
		Scope:            params.Scopes,
		SID:              params.SID,
		RootSID:          params.RootSID,
		Use:              use,
		SubType:          subType,
		Target:           params.Resources,
		AgentSessionID:   params.AgentSessionID,
		DelegationEdgeID: params.DelegationEdgeID,
		SourceSessionID:  params.SourceSessionID,
		TargetSessionID:  params.TargetSessionID,
		DelegationPath:   params.DelegationPath,
		DelegationChain:  params.DelegationChain,
		HopCount:         len(params.DelegationPath),
		GraphEpoch:       params.GraphEpoch,
	}

	t := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	if kid != "" {
		t.Header["kid"] = kid
	}
	signed, err := t.SignedString(key)
	if err != nil {
		return "", "", err
	}
	return signed, jtiStr, nil
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
	return json.Marshal(map[string]any{"keys": jwksKeys})
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
