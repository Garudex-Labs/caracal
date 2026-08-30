// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package settings reads runtime configuration from the enterprise_config
// table with a short in-process cache.
package settings

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// RowQuerier is the subset of a pgx pool the store needs.
type RowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Reader answers runtime configuration lookups.
type Reader interface {
	String(ctx context.Context, key, fallback string) string
	Bool(ctx context.Context, key string, fallback bool) bool
	Int(ctx context.Context, key string, fallback int) int
}

// Store reads settings with a freshness window matching the runtime-settings
// cache used elsewhere.
type Store struct {
	DB RowQuerier

	mu     sync.Mutex
	cache  map[string]cached
	maxAge time.Duration
}

var _ Reader = (*Store)(nil)

type cached struct {
	value   string
	fetched time.Time
}

const cacheTTL = 30 * time.Second

func (s *Store) get(ctx context.Context, key string) string {
	s.mu.Lock()
	if s.cache == nil {
		s.cache = map[string]cached{}
	}
	if s.maxAge == 0 {
		s.maxAge = cacheTTL
	}
	if entry, ok := s.cache[key]; ok && time.Since(entry.fetched) < s.maxAge {
		s.mu.Unlock()
		return entry.value
	}
	s.mu.Unlock()

	var value string
	if err := s.DB.QueryRow(ctx, `SELECT value FROM enterprise_config WHERE key = $1`, key).Scan(&value); err != nil {
		value = ""
	}
	s.mu.Lock()
	s.cache[key] = cached{value: value, fetched: time.Now()}
	s.mu.Unlock()
	return value
}

// String reads a setting; missing keys fall back.
func (s *Store) String(ctx context.Context, key, fallback string) string {
	if raw := s.get(ctx, key); raw != "" {
		return raw
	}
	return fallback
}

// Bool reads a boolean setting; missing keys fall back.
func (s *Store) Bool(ctx context.Context, key string, fallback bool) bool {
	raw := s.get(ctx, key)
	if raw == "" {
		return fallback
	}
	switch strings.ToLower(raw) {
	case "true", "1", "yes":
		return true
	default:
		return false
	}
}

// Int reads a non-negative integer setting; missing, invalid, or
// out-of-range keys fall back.
func (s *Store) Int(ctx context.Context, key string, fallback int) int {
	raw := s.get(ctx, key)
	if raw == "" {
		return fallback
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return fallback
		}
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return n
}

// Invalidate drops keys from the in-process cache so the next read
// re-fetches; writers call it after changing configuration rows.
func (s *Store) Invalidate(keys ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, key := range keys {
		delete(s.cache, key)
	}
}
