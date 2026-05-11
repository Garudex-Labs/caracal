// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Per-principal cooldown that throttles step-up challenge failures.

package internal

import (
	"sync"
	"time"
)

const (
	stepUpFailureWindow    = 2 * time.Minute
	stepUpFailureThreshold = 5
	stepUpCooldown         = 5 * time.Minute
)

type stepUpThrottle struct {
	mu      sync.Mutex
	entries map[string]*throttleState
	now     func() time.Time
}

type throttleState struct {
	failures      []time.Time
	cooldownUntil time.Time
}

func newStepUpThrottle() *stepUpThrottle {
	return &stepUpThrottle{entries: map[string]*throttleState{}, now: time.Now}
}

// Allow reports whether the principal is currently allowed to attempt a step-up.
func (t *stepUpThrottle) Allow(zoneID, principalID string) (bool, time.Duration) {
	if t == nil {
		return true, 0
	}
	key := zoneID + "\x00" + principalID
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.entries[key]
	if !ok {
		return true, 0
	}
	now := t.now()
	if now.Before(st.cooldownUntil) {
		return false, st.cooldownUntil.Sub(now)
	}
	return true, 0
}

// RecordFailure increments the failure counter and may set a cooldown when the
// threshold is crossed inside the failure window.
func (t *stepUpThrottle) RecordFailure(zoneID, principalID string) {
	if t == nil {
		return
	}
	key := zoneID + "\x00" + principalID
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.entries[key]
	if !ok {
		st = &throttleState{}
		t.entries[key] = st
	}
	now := t.now()
	cutoff := now.Add(-stepUpFailureWindow)
	kept := st.failures[:0]
	for _, ts := range st.failures {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	st.failures = append(kept, now)
	if len(st.failures) >= stepUpFailureThreshold {
		st.cooldownUntil = now.Add(stepUpCooldown)
		st.failures = nil
	}
}

// RecordSuccess clears any pending failure window after a successful step-up.
func (t *stepUpThrottle) RecordSuccess(zoneID, principalID string) {
	if t == nil {
		return
	}
	key := zoneID + "\x00" + principalID
	t.mu.Lock()
	delete(t.entries, key)
	t.mu.Unlock()
}
