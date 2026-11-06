// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Retention unit tests: leader guard and counter state.

package internal

import (
	"context"
	"testing"

	"github.com/rs/zerolog"
)

func TestRetentionSkipsWhenNotLeader(t *testing.T) {
	// leader.Held() == false by default (zero-value atomic.Bool)
	leader := &Leader{}
	r := &Retention{
		db:     &PGWriter{},
		leader: leader,
		log:    zerolog.Nop(),
	}
	// tick must return without touching db (nil pool would panic on any SQL call)
	r.tick(context.Background())
	if r.createdTotal.Load() != 0 || r.droppedTotal.Load() != 0 {
		t.Error("non-leader tick must not increment counters")
	}
}

func TestRetentionCountersStartAtZero(t *testing.T) {
	r := newRetention(&PGWriter{}, nil, 90, zerolog.Nop())
	if r.createdTotal.Load() != 0 {
		t.Error("createdTotal must start at zero")
	}
	if r.droppedTotal.Load() != 0 {
		t.Error("droppedTotal must start at zero")
	}
}
