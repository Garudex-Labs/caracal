// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for STS JWT signing key management.

package internal

import (
	"bytes"
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

type signingKeyDB struct {
	stubDB
	secret      *SecretRow
	getCalls    int
	ensureCalls int
}

func (s *signingKeyDB) GetZoneSigningKeySecret(_ context.Context, _ string) (*SecretRow, error) {
	s.getCalls++
	if s.secret == nil {
		return nil, pgx.ErrNoRows
	}
	return s.secret, nil
}

func (s *signingKeyDB) EnsureZoneSigningKeySecret(_ context.Context, _ string, envelope []byte) (*SecretRow, error) {
	s.ensureCalls++
	s.secret = &SecretRow{ID: "generated-key", Envelope: envelope}
	return s.secret, nil
}

func TestKeyCacheGeneratesMissingZoneSigningKey(t *testing.T) {
	db := &signingKeyDB{}
	cache := newKeyCache(db, bytes.Repeat([]byte{7}, 32))

	key, kid, err := cache.getKeyAndKid(context.Background(), "zone-1")
	if err != nil {
		t.Fatal(err)
	}
	if key == nil || kid != "generated-key" {
		t.Fatalf("expected generated signing key, got key=%v kid=%q", key, kid)
	}
	if db.getCalls != 1 || db.ensureCalls != 1 {
		t.Fatalf("expected one load and one ensure, got loads=%d ensures=%d", db.getCalls, db.ensureCalls)
	}

	if _, _, err := cache.getKeyAndKid(context.Background(), "zone-1"); err != nil {
		t.Fatal(err)
	}
	if db.getCalls != 1 || db.ensureCalls != 1 {
		t.Fatalf("expected cached key reuse, got loads=%d ensures=%d", db.getCalls, db.ensureCalls)
	}
}
