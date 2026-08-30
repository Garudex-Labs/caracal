// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"errors"
	"fmt"
	"testing"
)

func TestErrorConstructorsAndKinds(t *testing.T) {
	cases := []struct {
		err  *Error
		kind Kind
		msg  string
	}{
		{migrationErrorf("a %d", 1), KindMigration, "a 1"},
		{checksumErrorf("b %s", "x"), KindChecksumMismatch, "b x"},
		{connectionErrorf("c"), KindConnectionFailed, "c"},
		{prerequisiteErrorf("d"), KindPrerequisite, "d"},
	}
	for _, tc := range cases {
		if tc.err.Kind != tc.kind {
			t.Fatalf("Kind = %s, want %s", tc.err.Kind, tc.kind)
		}
		if tc.err.Message != tc.msg || tc.err.Error() != tc.msg {
			t.Fatalf("Message/Error = %q/%q, want %q", tc.err.Message, tc.err.Error(), tc.msg)
		}
	}
}

func TestAsError(t *testing.T) {
	// A plain error is wrapped as the generic migration kind.
	wrapped := AsError(errors.New("boom"))
	if wrapped.Kind != KindMigration || wrapped.Message != "boom" {
		t.Fatalf("AsError(plain) = %+v", wrapped)
	}
	// An existing *Error is returned unchanged (same pointer).
	orig := checksumErrorf("chk")
	if got := AsError(orig); got != orig {
		t.Fatalf("AsError(*Error) should return the same pointer")
	}
	// A *Error wrapped with %w is recovered through errors.As.
	chain := fmt.Errorf("context: %w", connectionErrorf("down"))
	got := AsError(chain)
	if got.Kind != KindConnectionFailed || got.Message != "down" {
		t.Fatalf("AsError(chain) = %+v, want connection/down", got)
	}
}
