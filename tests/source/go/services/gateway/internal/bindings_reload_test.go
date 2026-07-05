// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway binding store failure-path tests: reload retries, revision validation, and polling.

package internal

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type bindingResult struct {
	rows pgx.Rows
	err  error
}

// scriptedBindingPool replays a fixed sequence of query results and then keeps
// returning empty result sets.
type scriptedBindingPool struct {
	results []bindingResult
	calls   int
}

func (p *scriptedBindingPool) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	if p.calls >= len(p.results) {
		return &fakeRows{}, nil
	}
	r := p.results[p.calls]
	p.calls++
	return r.rows, r.err
}

// errScanRows yields a single row whose Scan always fails.
type errScanRows struct {
	fakeRows
	scanErr error
}

func (r *errScanRows) Next() bool {
	r.index++
	return r.index == 1
}

func (r *errScanRows) Scan(...any) error {
	return r.scanErr
}

func revisionRow(v int64) bindingResult {
	return bindingResult{rows: rowValues([]any{v})}
}

func emptyBindings() bindingResult {
	return bindingResult{rows: &fakeRows{}}
}

func TestBindingReloadSurfacesQueryFailures(t *testing.T) {
	ctx := context.Background()
	queryErr := errors.New("pg down")

	store := newTestBindingStore(&scriptedBindingPool{results: []bindingResult{{err: queryErr}}})
	if err := store.Reload(ctx); !errors.Is(err, queryErr) {
		t.Fatalf("revision failure = %v", err)
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{revisionRow(1), {err: queryErr}}})
	if err := store.Reload(ctx); !errors.Is(err, queryErr) {
		t.Fatalf("load failure = %v", err)
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{revisionRow(1), emptyBindings(), {err: queryErr}}})
	if err := store.Reload(ctx); !errors.Is(err, queryErr) {
		t.Fatalf("post-load revision failure = %v", err)
	}
}

func TestBindingReloadGivesUpAfterRevisionDrift(t *testing.T) {
	results := []bindingResult{}
	for attempt := 0; attempt < bindingReloadAttempts; attempt++ {
		results = append(results, revisionRow(int64(attempt)), emptyBindings(), revisionRow(int64(attempt+1)))
	}
	store := newTestBindingStore(&scriptedBindingPool{results: results})
	err := store.Reload(context.Background())
	if err == nil || err.Error() != "gateway bindings changed during reload" {
		t.Fatalf("drift error = %v", err)
	}
}

func TestBindingReloadIfChangedSurfacesQueryFailures(t *testing.T) {
	ctx := context.Background()
	queryErr := errors.New("pg down")

	store := newTestBindingStore(&scriptedBindingPool{results: []bindingResult{{err: queryErr}}})
	if err := store.ReloadIfChanged(ctx); !errors.Is(err, queryErr) {
		t.Fatalf("revision failure = %v", err)
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{revisionRow(5), {err: queryErr}}})
	if err := store.ReloadIfChanged(ctx); !errors.Is(err, queryErr) {
		t.Fatalf("load failure = %v", err)
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{revisionRow(5), emptyBindings(), {err: queryErr}}})
	if err := store.ReloadIfChanged(ctx); !errors.Is(err, queryErr) {
		t.Fatalf("post-load revision failure = %v", err)
	}
}

func TestBindingReloadIfChangedGivesUpAfterRevisionDrift(t *testing.T) {
	results := []bindingResult{revisionRow(5)}
	for attempt := 0; attempt < bindingReloadAttempts; attempt++ {
		results = append(results, emptyBindings(), revisionRow(int64(6+attempt)))
	}
	store := newTestBindingStore(&scriptedBindingPool{results: results})
	err := store.ReloadIfChanged(context.Background())
	if err == nil || err.Error() != "gateway bindings changed during incremental reload" {
		t.Fatalf("drift error = %v", err)
	}
}

func TestCurrentRevisionValidatesResultShape(t *testing.T) {
	ctx := context.Background()

	store := newTestBindingStore(&scriptedBindingPool{results: []bindingResult{{rows: &fakeRows{err: errors.New("row stream broken")}}}})
	if _, err := store.currentRevision(ctx); err == nil {
		t.Fatal("row-stream error must surface")
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{emptyBindings()}})
	if _, err := store.currentRevision(ctx); err == nil || err.Error() != "gateway binding revision row missing" {
		t.Fatalf("missing row error = %v", err)
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{{rows: &errScanRows{scanErr: errors.New("scan failed")}}}})
	if _, err := store.currentRevision(ctx); err == nil {
		t.Fatal("scan error must surface")
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{{rows: rowValues([]any{int64(1)}, []any{int64(2)})}}})
	if _, err := store.currentRevision(ctx); err == nil || err.Error() != "gateway binding revision returned multiple rows" {
		t.Fatalf("multiple rows error = %v", err)
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{{rows: &fakeRows{values: [][]any{{int64(4)}}, err: errors.New("late error")}}}})
	if _, err := store.currentRevision(ctx); err == nil {
		t.Fatal("post-scan rows error must surface")
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{revisionRow(-1)}})
	if _, err := store.currentRevision(ctx); err == nil {
		t.Fatal("negative revision must surface")
	}
}

func TestLoadBindingsSurfacesRowErrors(t *testing.T) {
	ctx := context.Background()

	store := newTestBindingStore(&scriptedBindingPool{results: []bindingResult{{rows: &errScanRows{scanErr: errors.New("scan failed")}}}})
	if _, err := store.loadBindings(ctx); err == nil {
		t.Fatal("scan error must surface")
	}

	store = newTestBindingStore(&scriptedBindingPool{results: []bindingResult{{rows: &fakeRows{err: errors.New("row stream broken")}}}})
	if _, err := store.loadBindings(ctx); err == nil {
		t.Fatal("row-stream error must surface")
	}
}

// signalPool reports the first poll query on a channel so tests can observe a tick.
type signalPool struct {
	once sync.Once
	ch   chan struct{}
}

func (p *signalPool) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	p.once.Do(func() { close(p.ch) })
	return nil, errors.New("poll probe")
}

func TestBindingStartPollingTicksAndStops(t *testing.T) {
	pool := &signalPool{ch: make(chan struct{})}
	store := newTestBindingStore(pool)
	store.pollInterval = time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		store.StartPolling(ctx)
		close(done)
	}()
	select {
	case <-pool.ch:
	case <-time.After(5 * time.Second):
		t.Fatal("polling never queried the pool")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("polling did not stop on cancel")
	}
}
