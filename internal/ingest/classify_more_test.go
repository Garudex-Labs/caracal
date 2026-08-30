// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

func TestClassifierForUnknownHarness(t *testing.T) {
	reg := harness.MustLoad()
	if _, err := classifierFor(reg, "totally-unknown-harness"); err == nil {
		t.Error("classifierFor on unknown harness should error")
	}
	if _, err := NewBuilder(reg, "totally-unknown-harness"); err == nil {
		t.Error("NewBuilder on unknown harness should error")
	}
}

func TestInsertEventsEmptyIsNoop(t *testing.T) {
	// len(events)==0 returns before the ClickHouse client is touched, so a
	// nil-client store is safe here.
	if err := (&CHStore{}).InsertEvents(context.Background(), nil); err != nil {
		t.Errorf("InsertEvents(nil) = %v, want nil", err)
	}
}

func TestExistingLineHashesInvertedRange(t *testing.T) {
	// min > max returns an empty map before any query, so no client is needed.
	got, err := (&CHStore{}).ExistingLineHashes(context.Background(), SessionKey{}, 10, 3)
	if err != nil {
		t.Fatalf("ExistingLineHashes inverted range error = %v", err)
	}
	if len(got) != 0 {
		t.Errorf("inverted range map = %#v, want empty", got)
	}
}
