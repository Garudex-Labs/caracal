// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// In-memory Store with per-entry TTLs.

package revocation

import (
	"sync"
	"time"
)

// InMemoryStore is a process-local Store backed by a TTL map.
type InMemoryStore struct {
	mu      sync.Mutex
	entries map[string]time.Time
	defTTL  time.Duration
}

// NewInMemoryStore returns a Store using defaultTTL for entries that omit a TTL.
func NewInMemoryStore(defaultTTL time.Duration) *InMemoryStore {
	if defaultTTL <= 0 {
		defaultTTL = 24 * time.Hour
	}
	return &InMemoryStore{entries: map[string]time.Time{}, defTTL: defaultTTL}
}

// IsRevoked reports whether sid is currently revoked, evicting expired entries.
func (s *InMemoryStore) IsRevoked(sid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	expiresAt, ok := s.entries[sid]
	if !ok {
		return false
	}
	if !time.Now().Before(expiresAt) {
		delete(s.entries, sid)
		return false
	}
	return true
}

// MarkRevoked records sid as revoked for ttl, falling back to the default TTL when zero.
func (s *InMemoryStore) MarkRevoked(sid string, ttl time.Duration) {
	if ttl <= 0 {
		ttl = s.defTTL
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[sid] = time.Now().Add(ttl)
}
