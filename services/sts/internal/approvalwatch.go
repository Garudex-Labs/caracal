// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// In-process wakeup registry connecting approval decision notifications to long-poll waiters.

package internal

import (
	"context"
	"sync"
	"time"
)

// approvalWatch fans one decision notification out to every long-poll waiter on that
// approval. Waiters re-read the row on wakeup, so a spurious or missed notification
// costs at most one fallback poll interval, never correctness.
type approvalWatch struct {
	mu      sync.Mutex
	waiters map[string]map[chan struct{}]struct{}
}

func newApprovalWatch() *approvalWatch {
	return &approvalWatch{waiters: map[string]map[chan struct{}]struct{}{}}
}

// subscribe registers a waiter for one approval id and returns its wakeup channel
// plus the cancel that must run when the wait ends. A nil registry returns a nil
// channel, which never fires, so a waiter degrades to its fallback poll interval.
func (w *approvalWatch) subscribe(id string) (<-chan struct{}, func()) {
	if w == nil {
		return nil, func() {}
	}
	ch := make(chan struct{}, 1)
	w.mu.Lock()
	set, ok := w.waiters[id]
	if !ok {
		set = map[chan struct{}]struct{}{}
		w.waiters[id] = set
	}
	set[ch] = struct{}{}
	w.mu.Unlock()
	return ch, func() {
		w.mu.Lock()
		if set, ok := w.waiters[id]; ok {
			delete(set, ch)
			if len(set) == 0 {
				delete(w.waiters, id)
			}
		}
		w.mu.Unlock()
	}
}

// wake signals every waiter registered for the approval id.
func (w *approvalWatch) wake(id string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	set := w.waiters[id]
	channels := make([]chan struct{}, 0, len(set))
	for ch := range set {
		channels = append(channels, ch)
	}
	w.mu.Unlock()
	for _, ch := range channels {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// startApprovalWatch pumps decision notifications into the registry for the server's
// lifetime. A dropped listen connection degrades waiters to their fallback poll
// interval while the loop reconnects.
func (s *Server) startApprovalWatch(ctx context.Context) {
	for {
		err := s.db.WaitForApprovalNotifications(ctx, s.approvals.wake)
		if ctx.Err() != nil {
			return
		}
		s.log.Warn().Err(err).Msg("approval notification listener interrupted; waiters fall back to polling")
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}
