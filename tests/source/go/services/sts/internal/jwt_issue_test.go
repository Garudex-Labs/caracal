// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Token issuance and zone signing key cache tests.

package internal

import (
	"context"
	"crypto/elliptic"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func signingZEK() []byte {
	zek := make([]byte, 32)
	for i := range zek {
		zek[i] = byte(i + 1)
	}
	return zek
}

func signingKeyCache(t *testing.T) (*KeyCache, *stubDB, string) {
	t.Helper()
	zek := signingZEK()
	pemKey := ecKeyPEM(t, elliptic.P256())
	db := &stubDB{secrets: []SecretRow{sealedSecret(t, zek, "kid-active", []byte(pemKey))}}
	return newKeyCache(db, zek), db, pemKey
}

func TestIssueTokenSessionAndResourceClaims(t *testing.T) {
	keys, _, pemKey := signingKeyCache(t)
	priv, err := jwt.ParseECPrivateKeyFromPEM([]byte(pemKey))
	if err != nil {
		t.Fatal(err)
	}

	parse := func(t *testing.T, signed string) (*Claims, map[string]any) {
		t.Helper()
		claims := &Claims{}
		token, err := jwt.ParseWithClaims(signed, claims, func(token *jwt.Token) (any, error) {
			return &priv.PublicKey, nil
		}, jwt.WithValidMethods([]string{"ES256"}))
		if err != nil || !token.Valid {
			t.Fatalf("token must verify with the zone key: %v", err)
		}
		return claims, token.Header
	}

	issuedAt := time.Now().Truncate(time.Second)
	signed, jti, err := issueToken(context.Background(), IssueParams{
		ZoneID:    "zone-1",
		AppID:     "son-of-anton",
		SubjectID: "user:richard.hendricks@piedpiper.example",
		SubType:   SubTypeUser,
		Use:       UseSession,
		SID:       "sid-1",
		RootSID:   "sid-root",
		Scopes:    "read",
		Resources: []string{"resource://pipernet"},
		TTL:       time.Minute,
		IssuedAt:  issuedAt,
	}, keys, "https://sts.piedpiper.example")
	if err != nil || jti == "" {
		t.Fatalf("issue failed: %v", err)
	}
	claims, header := parse(t, signed)
	if header["kid"] != "kid-active" {
		t.Fatalf("kid header = %v", header["kid"])
	}
	if len(claims.Audience) != 1 || claims.Audience[0] != "https://sts.piedpiper.example" {
		t.Fatalf("session mandate audience must be the issuer only: %v", claims.Audience)
	}
	if claims.ID != jti || claims.Use != UseSession || claims.SubType != SubTypeUser {
		t.Fatalf("claims wrong: %+v", claims)
	}
	if !claims.ExpiresAt.Time.Equal(issuedAt.Add(time.Minute)) {
		t.Fatalf("expiry = %v, want issuedAt+1m", claims.ExpiresAt.Time)
	}

	signed, _, err = issueToken(context.Background(), IssueParams{
		ZoneID:         "zone-1",
		AppID:          "son-of-anton",
		SubjectID:      "son-of-anton",
		SID:            "sid-2",
		RootSID:        "sid-root",
		Resources:      []string{"resource://pipernet", "resource://nucleus"},
		TTL:            time.Minute,
		DelegationPath: []string{"edge-1", "edge-2"},
		GraphEpoch:     9,
	}, keys, "https://sts.piedpiper.example")
	if err != nil {
		t.Fatal(err)
	}
	claims, _ = parse(t, signed)
	if claims.Use != UseResource || claims.SubType != SubTypeApplication {
		t.Fatalf("defaults must be resource/application: %+v", claims)
	}
	if len(claims.Audience) != 2 || claims.Audience[0] != "resource://pipernet" {
		t.Fatalf("resource mandate audience must be its targets: %v", claims.Audience)
	}
	if claims.HopCount != 2 || claims.GraphEpoch != 9 {
		t.Fatalf("delegation claims wrong: hop=%d epoch=%d", claims.HopCount, claims.GraphEpoch)
	}
}

func TestIssueTokenFailsWithoutSigningKey(t *testing.T) {
	keys := newKeyCache(&stubDB{secretsErr: errors.New("pg down")}, signingZEK())
	if _, _, err := issueToken(context.Background(), IssueParams{ZoneID: "zone-1", TTL: time.Minute}, keys, "https://sts.piedpiper.example"); err == nil {
		t.Fatal("missing signing key must fail issuance")
	}
}

func TestKeyCacheServesAndInvalidatesZoneKeys(t *testing.T) {
	keys, db, _ := signingKeyCache(t)

	pub, kid, err := keys.getPublicKeyAndKid(context.Background(), "zone-1")
	if err != nil || pub == nil || kid != "kid-active" {
		t.Fatalf("public key lookup failed: kid=%q err=%v", kid, err)
	}

	db.secretsErr = errors.New("pg down")
	if _, kid, err := keys.getKeyAndKid(context.Background(), "zone-1"); err != nil || kid != "kid-active" {
		t.Fatalf("cached key must survive db outage: kid=%q err=%v", kid, err)
	}

	keys.Invalidate("zone-1")
	if _, _, err := keys.getKeyAndKid(context.Background(), "zone-1"); err == nil {
		t.Fatal("invalidated cache must hit the failing database")
	}
}

func TestGetPublicKeysByZoneAccumulatesFailures(t *testing.T) {
	zek := signingZEK()
	pemKey := ecKeyPEM(t, elliptic.P256())

	t.Run("no keys", func(t *testing.T) {
		keys := newKeyCache(&stubDB{}, zek)
		if _, err := keys.getPublicKeysByZone(context.Background(), "zone-1"); err == nil {
			t.Fatal("zone without keys must fail")
		}
	})

	t.Run("mixed failures name the kids", func(t *testing.T) {
		db := &stubDB{secrets: []SecretRow{
			sealedSecret(t, zek, "kid-good", []byte(pemKey)),
			{ID: "kid-garbled", Envelope: []byte("garbage")},
			sealedSecret(t, zek, "kid-not-ec", []byte("not a key")),
		}}
		keys := newKeyCache(db, zek)
		_, err := keys.getPublicKeysByZone(context.Background(), "zone-1")
		if err == nil || !strings.Contains(err.Error(), "kid-garbled") || !strings.Contains(err.Error(), "kid-not-ec") {
			t.Fatalf("error must name the failed kids: %v", err)
		}
	})

	t.Run("healthy keys are cached", func(t *testing.T) {
		db := &stubDB{secrets: []SecretRow{
			sealedSecret(t, zek, "kid-active", []byte(pemKey)),
			sealedSecret(t, zek, "kid-previous", []byte(ecKeyPEM(t, elliptic.P256()))),
		}}
		keys := newKeyCache(db, zek)
		result, err := keys.getPublicKeysByZone(context.Background(), "zone-1")
		if err != nil || len(result) != 2 {
			t.Fatalf("expected both rotation keys: %v err=%v", result, err)
		}
		db.secretsErr = errors.New("pg down")
		if _, err := keys.getPublicKeysByZone(context.Background(), "zone-1"); err != nil {
			t.Fatalf("cached keys must survive db outage: %v", err)
		}
	})
}
