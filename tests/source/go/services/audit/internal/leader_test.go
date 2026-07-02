// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Leader election tests covering acquisition, liveness loss, re-contention, and release.

package internal

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

type fakeLease struct {
	mu         sync.Mutex
	pingErr    error
	pingCalls  int
	released   int
	releaseErr error
}

func (f *fakeLease) Ping(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pingCalls++
	return f.pingErr
}

func (f *fakeLease) Release(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.released++
	return f.releaseErr
}

func (f *fakeLease) releases() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.released
}

type fakeStore struct {
	mu      sync.Mutex
	results []acquireResult
	calls   int
}

type acquireResult struct {
	lease advisoryLease
	ok    bool
	err   error
}

func (s *fakeStore) AcquireAdvisoryLock(context.Context, int64) (advisoryLease, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.calls
	s.calls++
	if i >= len(s.results) {
		return nil, false, nil
	}
	r := s.results[i]
	return r.lease, r.ok, r.err
}

func newTestLeader(store leaderStore) *Leader {
	return newLeader(store, 1, zerolog.Nop())
}

func TestTryAcquireSuccess(t *testing.T) {
	lease := &fakeLease{}
	l := newTestLeader(&fakeStore{results: []acquireResult{{lease: lease, ok: true}}})
	l.tryAcquire(context.Background())
	if !l.Held() {
		t.Fatal("expected leader to be held after successful acquire")
	}
	if got := l.Transitions(); got != 1 {
		t.Fatalf("expected 1 transition, got %d", got)
	}
}

func TestTryAcquireContended(t *testing.T) {
	l := newTestLeader(&fakeStore{results: []acquireResult{{ok: false}}})
	l.tryAcquire(context.Background())
	if l.Held() {
		t.Fatal("expected follower when lock is contended")
	}
	if got := l.Transitions(); got != 0 {
		t.Fatalf("expected 0 transitions, got %d", got)
	}
}

func TestTryAcquireError(t *testing.T) {
	l := newTestLeader(&fakeStore{results: []acquireResult{{err: errors.New("db down")}}})
	l.tryAcquire(context.Background())
	if l.Held() {
		t.Fatal("expected follower when acquire errors")
	}
	if got := l.Transitions(); got != 0 {
		t.Fatalf("expected 0 transitions, got %d", got)
	}
}

func TestVerifyHealthyStaysLeader(t *testing.T) {
	lease := &fakeLease{}
	l := newTestLeader(&fakeStore{results: []acquireResult{{lease: lease, ok: true}}})
	l.tryAcquire(context.Background())
	l.verify(context.Background())
	if !l.Held() {
		t.Fatal("expected leader to remain held after healthy probe")
	}
	if lease.pingCalls != 1 {
		t.Fatalf("expected 1 ping, got %d", lease.pingCalls)
	}
	if got := l.Transitions(); got != 1 {
		t.Fatalf("expected 1 transition, got %d", got)
	}
}

func TestVerifyLostThenReacquire(t *testing.T) {
	lost := &fakeLease{pingErr: errors.New("connection reset")}
	fresh := &fakeLease{}
	store := &fakeStore{results: []acquireResult{
		{lease: lost, ok: true},
		{lease: fresh, ok: true},
	}}
	l := newTestLeader(store)
	l.tryAcquire(context.Background())
	l.verify(context.Background())
	if !l.Held() {
		t.Fatal("expected leadership regained after re-contention")
	}
	if lost.releases() != 1 {
		t.Fatalf("expected lost lease released once, got %d", lost.releases())
	}
	// acquire(+1) -> loss(+1) -> reacquire(+1)
	if got := l.Transitions(); got != 3 {
		t.Fatalf("expected 3 transitions, got %d", got)
	}
}

func TestVerifyLostThenContended(t *testing.T) {
	lost := &fakeLease{pingErr: errors.New("connection reset")}
	store := &fakeStore{results: []acquireResult{
		{lease: lost, ok: true},
		{ok: false},
	}}
	l := newTestLeader(store)
	l.tryAcquire(context.Background())
	l.verify(context.Background())
	if l.Held() {
		t.Fatal("expected follower after losing lease and failing to re-contend")
	}
	if lost.releases() != 1 {
		t.Fatalf("expected lost lease released once, got %d", lost.releases())
	}
	// acquire(+1) -> loss(+1)
	if got := l.Transitions(); got != 2 {
		t.Fatalf("expected 2 transitions, got %d", got)
	}
}

func TestStepDownReleasesLease(t *testing.T) {
	lease := &fakeLease{}
	l := newTestLeader(&fakeStore{results: []acquireResult{{lease: lease, ok: true}}})
	l.tryAcquire(context.Background())
	l.stepDown()
	if l.Held() {
		t.Fatal("expected follower after step down")
	}
	if lease.releases() != 1 {
		t.Fatalf("expected lease released once, got %d", lease.releases())
	}
	if got := l.Transitions(); got != 2 {
		t.Fatalf("expected 2 transitions, got %d", got)
	}
}

func TestRunReleasesLeaseOnCancel(t *testing.T) {
	lease := &fakeLease{}
	l := newTestLeader(&fakeStore{results: []acquireResult{{lease: lease, ok: true}}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		l.Run(ctx)
		close(done)
	}()
	// Run acquires immediately before the first tick; poll until held.
	deadline := time.After(2 * time.Second)
	for !l.Held() {
		select {
		case <-deadline:
			t.Fatal("leader never acquired")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	if l.Held() {
		t.Fatal("expected follower after Run returns")
	}
	if lease.releases() != 1 {
		t.Fatalf("expected lease released once on shutdown, got %d", lease.releases())
	}
}
