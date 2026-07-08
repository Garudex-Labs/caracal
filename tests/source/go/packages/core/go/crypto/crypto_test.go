// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared crypto unit tests for signing key generation.

package crypto

import "testing"

func TestGenerateP256Key(t *testing.T) {
	key, err := GenerateP256Key()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	if key.Curve == nil || key.X == nil || key.Y == nil || key.D == nil {
		t.Fatalf("generated key is incomplete: %#v", key)
	}
}
