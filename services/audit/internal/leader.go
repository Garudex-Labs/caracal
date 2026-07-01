// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// PG advisory-lock leader lease used by exporter, sweeper, and retention rotator
// so multi-replica deployments do not race S3 writes or partition DDL.

package internal

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
)

const (
	leaderRefreshInterval = 30 * time.Second
	leaderProbeTimeout    = 5 * time.Second
)

// advisoryLease is a held session-level advisory lock. Ping reports liveness and
// Release unlocks and returns the underlying connection to the pool.
type advisoryLease interface {
	Ping(context.Context) error
	Release(context.Context) error
}

type leaderStore interface {
	AcquireAdvisoryLock(context.Context, int64) (advisoryLease, bool, error)
}

type Leader struct {
	db          leaderStore
	key         int64
	log         zerolog.Logger
	lease       advisoryLease
	held        atomic.Bool
	transitions atomic.Int64
}

func newLeader(db leaderStore, key int64, log zerolog.Logger) *Leader {
	return &Leader{db: db, key: key, log: log}
}

// Run maintains the lease for the lifetime of ctx. When not held it contends for
// the lock; when held it verifies the lease connection is still alive each tick.
// Postgres releases a session-level advisory lock the instant its session ends
// (failover, restart, dropped connection, pooler recycle), so a leader that stops
// verifying liveness would keep reporting itself leader while another replica also
// acquires the lock, racing S3 writes and partition DDL. On ctx cancellation the
// lease is released so a graceful restart hands leadership over promptly.
func (l *Leader) Run(ctx context.Context) {
	t := time.NewTicker(leaderRefreshInterval)
	defer t.Stop()
	l.tryAcquire(ctx)
	for {
		select {
		case <-ctx.Done():
			l.stepDown()
			return
		case <-t.C:
			if l.held.Load() {
				l.verify(ctx)
			} else {
				l.tryAcquire(ctx)
			}
		}
	}
}

// tryAcquire contends for the lock under a bounded timeout so a hung Postgres
// cannot stall the maintenance loop.
func (l *Leader) tryAcquire(ctx context.Context) {
	probeCtx, cancel := context.WithTimeout(ctx, leaderProbeTimeout)
	defer cancel()
	lease, ok, err := l.db.AcquireAdvisoryLock(probeCtx, l.key)
	if err != nil {
		l.log.Error().Err(err).Int64("key", l.key).Msg("leader: lock attempt failed")
		return
	}
	if !ok {
		return
	}
	l.lease = lease
	if !l.held.Swap(true) {
		l.transitions.Add(1)
	}
	l.log.Info().Int64("key", l.key).Msg("leader acquired")
}

// verify probes the lease connection under a bounded timeout. A failed probe means
// the session ended and Postgres has already released the lock, so the leader steps
// down and re-contends immediately rather than continuing to act as a stale leader.
func (l *Leader) verify(ctx context.Context) {
	if l.lease == nil {
		l.held.Store(false)
		return
	}
	probeCtx, cancel := context.WithTimeout(ctx, leaderProbeTimeout)
	defer cancel()
	if err := l.lease.Ping(probeCtx); err != nil {
		l.log.Warn().Err(err).Int64("key", l.key).Msg("leader: lease connection lost, stepping down")
		l.stepDown()
		l.tryAcquire(ctx)
	}
}

// stepDown releases the lease and marks this replica a follower. Release runs on a
// background context so a cancelled or hung run context cannot leave the lock and
// its pool connection leaked.
func (l *Leader) stepDown() {
	if l.lease != nil {
		ctx, cancel := context.WithTimeout(context.Background(), leaderProbeTimeout)
		if err := l.lease.Release(ctx); err != nil {
			l.log.Warn().Err(err).Int64("key", l.key).Msg("leader: advisory unlock failed")
		}
		cancel()
		l.lease = nil
	}
	if l.held.Swap(false) {
		l.transitions.Add(1)
	}
}

func (l *Leader) Held() bool { return l.held.Load() }

// Transitions returns the number of leadership changes (acquisitions plus losses)
// observed by this replica, so operators can alert on lease flapping.
func (l *Leader) Transitions() int64 { return l.transitions.Load() }
