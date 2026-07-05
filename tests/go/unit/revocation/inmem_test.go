// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// In-memory revocation store tests for TTL behavior.

package revocation_test

import (
	"testing"
	"time"

	revocation "github.com/garudex-labs/caracal/packages/revocation/go"
)

func TestInMemoryStoreRevokesUntilTTLExpiry(t *testing.T) {
	store := revocation.NewInMemoryStore(10 * time.Millisecond)

	if err := store.MarkRevoked("sid-1", 0); err != nil {
		t.Fatalf("mark revoked: %v", err)
	}
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

	if err := store.MarkRevoked("sid-1", time.Millisecond); err != nil {
		t.Fatalf("mark revoked: %v", err)
	}
	time.Sleep(10 * time.Millisecond)
	if store.IsRevoked("sid-1") {
		t.Fatal("expected explicit short ttl to expire")
	}
}

func TestInMemoryStoreTracksMonotonicDelegationEpochsUntilTTLExpiry(t *testing.T) {
	store := revocation.NewInMemoryStore(time.Hour)

	if got := store.CurrentDelegationEpoch("zone-1"); got != 0 {
		t.Fatalf("expected epoch 0, got %d", got)
	}
	if err := store.MarkDelegationEpoch("zone-1", 5, 0); err != nil {
		t.Fatalf("mark delegation epoch: %v", err)
	}
	if err := store.MarkDelegationEpoch("zone-1", 4, 0); err != nil {
		t.Fatalf("mark stale delegation epoch: %v", err)
	}
	if got := store.CurrentDelegationEpoch("zone-1"); got != 5 {
		t.Fatalf("expected epoch 5, got %d", got)
	}
	if err := store.MarkDelegationEpoch("zone-1", 6, time.Millisecond); err != nil {
		t.Fatalf("mark delegation epoch with ttl: %v", err)
	}
	if got := store.CurrentDelegationEpoch("zone-1"); got != 6 {
		t.Fatalf("expected epoch 6, got %d", got)
	}
	time.Sleep(10 * time.Millisecond)
	if got := store.CurrentDelegationEpoch("zone-1"); got != 0 {
		t.Fatalf("expected expired epoch to reset, got %d", got)
	}
}
