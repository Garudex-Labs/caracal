// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AuditBuffer unit tests: emit path, backpressure, dropped counter, and metrics snapshots.

package internal

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestAuditBufferEmitNonBlocking(t *testing.T) {
	buf, err := newAuditBuffer(nil, zerolog.Nop(), false, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}

	ev := AuditEvent{ID: "ev-1", ZoneID: "z1", Decision: "allow"}
	buf.Emit(ev)

	if buf.Dropped() != 0 {
		t.Errorf("want zero dropped, got %d", buf.Dropped())
	}
}

func TestAuditBufferPersistsWhenFull(t *testing.T) {
	dir := t.TempDir()
	buf := &AuditBuffer{
		ch:        make(chan AuditEvent, 1),
		log:       zerolog.Nop(),
		replayDir: dir,
	}
	buf.Emit(AuditEvent{ID: "ev-1"})
	buf.Emit(AuditEvent{ID: "ev-2"})

	if buf.Dropped() != 0 {
		t.Errorf("want zero dropped, got %d", buf.Dropped())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want one replay file, got %d", len(entries))
	}
}

func TestAuditBufferCloseWaitsForFlush(t *testing.T) {
	dir := t.TempDir()
	buf := &AuditBuffer{
		ch:        make(chan AuditEvent, 1),
		log:       zerolog.Nop(),
		replayDir: dir,
	}
	ctx, cancel := context.WithCancel(context.Background())
	buf.start(ctx)
	buf.Emit(AuditEvent{ID: "ev-1"})
	cancel()
	if err := buf.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want one replay file, got %d", len(entries))
	}
}

func TestAuditBufferOverflowDoesNotIncrementDroppedCounter(t *testing.T) {
	dir := t.TempDir()
	buf := &AuditBuffer{
		ch:        make(chan AuditEvent),
		log:       zerolog.Nop(),
		replayDir: dir,
	}
	for i := range 5 {
		_ = i
		buf.Emit(AuditEvent{ID: "ev"})
	}
	if buf.Dropped() != 0 {
		t.Errorf("want zero dropped, got %d", buf.Dropped())
	}
}

func TestAuditBufferDroppedInitiallyZero(t *testing.T) {
	buf, err := newAuditBuffer(nil, zerolog.Nop(), false, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if buf.Dropped() != 0 {
		t.Errorf("want 0 initially, got %d", buf.Dropped())
	}
}

func TestSTSMetricsSnapshotReflectsIncrements(t *testing.T) {
	m := &STSMetrics{}
	m.GraphTraversals.Add(3)
	m.GraphTraversalErrors.Add(1)

	snap := m.Snapshot()
	if snap.GraphTraversals != 3 {
		t.Errorf("want 3, got %d", snap.GraphTraversals)
	}
	if snap.GraphTraversalErrors != 1 {
		t.Errorf("want 1, got %d", snap.GraphTraversalErrors)
	}
}

func TestSTSMetricsSnapshotZeroValues(t *testing.T) {
	m := &STSMetrics{}
	snap := m.Snapshot()
	if snap.GraphTraversals != 0 || snap.GraphTraversalErrors != 0 {
		t.Errorf("want all-zero snapshot, got %+v", snap)
	}
}

func TestOPAMetricsSnapshotReflectsIncrements(t *testing.T) {
	e := newOPAEngine(nil)
	e.metrics.EvalTotal.Add(10)
	e.metrics.EvalErrors.Add(2)
	e.metrics.CompileTotal.Add(1)

	snap := e.MetricsSnapshot()
	if snap.EvalTotal != 10 {
		t.Errorf("want EvalTotal=10, got %d", snap.EvalTotal)
	}
	if snap.EvalErrors != 2 {
		t.Errorf("want EvalErrors=2, got %d", snap.EvalErrors)
	}
	if snap.CompileTotal != 1 {
		t.Errorf("want CompileTotal=1, got %d", snap.CompileTotal)
	}
}

func TestAuditBufferChannelCapacity(t *testing.T) {
	buf, err := newAuditBuffer(nil, zerolog.Nop(), false, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if cap(buf.ch) != auditBufCap {
		t.Errorf("want capacity %d, got %d", auditBufCap, cap(buf.ch))
	}
}

func TestAuditEventTimestamp(t *testing.T) {
	before := time.Now()
	ev, err := buildAuditEvent("req-x", "z1", "allow", "complete", &OPAResult{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now()
	if ev.OccurredAt.Before(before) || ev.OccurredAt.After(after) {
		t.Errorf("OccurredAt out of range: %v not in [%v, %v]", ev.OccurredAt, before, after)
	}
}
