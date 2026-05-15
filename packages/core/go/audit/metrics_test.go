// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the audit client metrics snapshot.

package audit

import (
	"context"
	"testing"

	"github.com/rs/zerolog"
)

type fakeStream struct {
	fail bool
}

func (f *fakeStream) XAdd(_ context.Context, _ string, _ map[string]any) error {
	if f.fail {
		return errStreamDown
	}
	return nil
}

var errStreamDown = &streamErr{"stream down"}

type streamErr struct{ msg string }

func (e *streamErr) Error() string { return e.msg }

func TestSnapshotCounters(t *testing.T) {
	dir := t.TempDir()
	c, err := NewClient(&fakeStream{}, ClientConfig{
		ReplayDir: dir,
		Logger:    zerolog.Nop(),
		BufferCap: 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		c.Emit(Event{ID: "e", EventType: "test"})
	}
	snap := c.Snapshot()
	if snap.Emitted == 0 && snap.Dropped == 0 {
		t.Fatalf("expected counters to advance: %+v", snap)
	}
	if snap.QueueCap != 4 {
		t.Fatalf("queue cap: %d", snap.QueueCap)
	}
}
