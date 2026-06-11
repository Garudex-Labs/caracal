// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for STS server configuration validation.

package internal

import (
	"strings"
	"testing"
)

func TestResolveKEKRejectsWeakLocalKeys(t *testing.T) {
	tests := map[string]string{
		"all zeros":   strings.Repeat("00", 32),
		"all ones":    strings.Repeat("11", 32),
		"sequential":  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
		"descending":  "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100",
		"alternating": strings.Repeat("aa55", 16),
	}
	for name, value := range tests {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ZONE_KEK", value)
			if _, err := resolveKEK("local"); err == nil {
				t.Fatal("expected weak ZONE_KEK to be rejected")
			}
		})
	}
}

func TestResolveKEKAcceptsHighEntropyLocalKey(t *testing.T) {
	t.Setenv("ZONE_KEK", "8f3d9a71c2b44e5f96a103d7be28cc41d5f09ab6731e4c8f2a7db56019ce34af")
	key, err := resolveKEK("local")
	if err != nil {
		t.Fatalf("resolveKEK returned error: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("resolveKEK returned %d bytes, want 32", len(key))
	}
}
