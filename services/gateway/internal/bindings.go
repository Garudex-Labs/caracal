// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Postgres-backed cache of zone/resource→application bindings; periodic poll keeps it fresh.

package internal

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

const defaultBindingPollInterval = 30 * time.Second

// binding is the resolved identity for a proxied resource: zone scoping and the
// application id that the gateway exchanges as.
type binding struct {
	ZoneID        string
	ApplicationID string
}

// bindingStore caches zone/resource→application rows from
// gateway_resource_bindings and refreshes them on the configured cadence.
// Lookups are wait-free against the cached snapshot, so a slow Postgres does
// not block the proxy hot path.
type bindingStore struct {
	pool         *pgxpool.Pool
	log          zerolog.Logger
	pollInterval time.Duration
	cache        atomic.Pointer[map[string]binding]
	mu           sync.Mutex
}

func newBindingStore(pool *pgxpool.Pool, log zerolog.Logger) *bindingStore {
	s := &bindingStore{pool: pool, log: log, pollInterval: defaultBindingPollInterval}
	empty := map[string]binding{}
	s.cache.Store(&empty)
	return s
}

// Get returns the binding for zone/resource, or zero binding with ok=false if none exists.
func (s *bindingStore) Get(zoneID, resource string) (binding, bool) {
	m := *s.cache.Load()
	b, ok := m[bindingKey(zoneID, resource)]
	return b, ok
}

// Size returns the number of bindings currently cached.
func (s *bindingStore) Size() int {
	return len(*s.cache.Load())
}

// Reload re-reads every binding row in a single query and atomically swaps the cache.
// Errors leave the previous snapshot in place so a flaky DB does not blank the gateway.
func (s *bindingStore) Reload(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.pool.Query(ctx, `SELECT resource_identifier, zone_id, application_id FROM gateway_resource_bindings`)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := make(map[string]binding)
	for rows.Next() {
		var resource string
		var b binding
		if err := rows.Scan(&resource, &b.ZoneID, &b.ApplicationID); err != nil {
			return err
		}
		out[bindingKey(b.ZoneID, resource)] = b
	}
	if err := rows.Err(); err != nil {
		return err
	}
	s.cache.Store(&out)
	return nil
}

func bindingKey(zoneID, resource string) string {
	return zoneID + "\x00" + resource
}

// StartPolling refreshes the cache on every tick until ctx is cancelled. Each failure
// is logged but does not stop the loop; the previous snapshot keeps serving lookups.
func (s *bindingStore) StartPolling(ctx context.Context) {
	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := s.Reload(ctx); err != nil {
				s.log.Error().Err(err).Msg("gateway bindings reload failed")
			}
		case <-ctx.Done():
			return
		}
	}
}
