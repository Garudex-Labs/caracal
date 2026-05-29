// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for audit event decision classification.

package audit

import "testing"

func TestIsDeny(t *testing.T) {
	cases := map[string]bool{
		"deny":  true,
		"DENY":  true,
		"Deny":  true,
		"allow": false,
		"":      false,
		"den":   false,
	}
	for decision, want := range cases {
		if got := (Event{Decision: decision}).IsDeny(); got != want {
			t.Errorf("IsDeny(%q) = %v, want %v", decision, got, want)
		}
	}
}
