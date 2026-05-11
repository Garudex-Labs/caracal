// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// In-memory revocation store tests for TTL behavior.

package revocation_test

import (
	"testing"
	"time"

	"github.com/garudex-labs/caracal/revocation"
)

func TestInMemoryStoreRevokesUntilTTLExpiry(t *testing.T) {
	store := revocation.NewInMemoryStore(10 * time.Millisecond)

	store.MarkRevoked("sid-1", 0)
	if !store.IsRevoked("sid-1") {
		t.Fatal("expected sid to be revoked")
	}
	time.Sleep(20 * time.Millisecond)
	if store.IsRevoked("sid-1") {
		t.Fatal("expected sid to expire")
	}
	if store.IsRevoked("sid-1") {
		t.Fatal("expected expired sid to stay evicted")
	}
}

func TestInMemoryStoreExplicitTTLOverridesDefault(t *testing.T) {
	store := revocation.NewInMemoryStore(time.Hour)

	store.MarkRevoked("sid-1", time.Millisecond)
	time.Sleep(10 * time.Millisecond)
	if store.IsRevoked("sid-1") {
		t.Fatal("expected explicit short ttl to expire")
	}
}
