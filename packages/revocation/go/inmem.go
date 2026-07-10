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
	epochs  map[string]epochEntry
	defTTL  time.Duration
}

type epochEntry struct {
	expiresAt time.Time
	epoch     int64
}

// NewInMemoryStore returns a Store using defaultTTL for entries that omit a TTL.
func NewInMemoryStore(defaultTTL time.Duration) *InMemoryStore {
	if defaultTTL <= 0 {
		defaultTTL = 24 * time.Hour
	}
	return &InMemoryStore{entries: map[string]time.Time{}, epochs: map[string]epochEntry{}, defTTL: defaultTTL}
}

// IsRevoked reports whether anchorID is currently revoked, evicting expired entries.
func (s *InMemoryStore) IsRevoked(anchorID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	expiresAt, ok := s.entries[anchorID]
	if !ok {
		return false
	}
	if !time.Now().Before(expiresAt) {
		delete(s.entries, anchorID)
		return false
	}
	return true
}

// MarkRevoked records anchorID as revoked for ttl, falling back to the default TTL when zero.
func (s *InMemoryStore) MarkRevoked(anchorID string, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = s.defTTL
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[anchorID] = time.Now().Add(ttl)
	return nil
}

// CurrentDelegationEpoch returns the recorded delegation graph epoch for zoneID, evicting expired entries.
func (s *InMemoryStore) CurrentDelegationEpoch(zoneID string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentEpochLocked(zoneID)
}

// MarkDelegationEpoch records epoch for zoneID when it advances past the current value.
func (s *InMemoryStore) MarkDelegationEpoch(zoneID string, epoch int64, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = s.defTTL
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch <= s.currentEpochLocked(zoneID) {
		return nil
	}
	s.epochs[zoneID] = epochEntry{expiresAt: time.Now().Add(ttl), epoch: epoch}
	return nil
}

func (s *InMemoryStore) currentEpochLocked(zoneID string) int64 {
	entry, ok := s.epochs[zoneID]
	if !ok {
		return 0
	}
	if !time.Now().Before(entry.expiresAt) {
		delete(s.epochs, zoneID)
		return 0
	}
	return entry.epoch
}
