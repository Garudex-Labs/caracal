// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package resretention

import (
	"context"
	"log/slog"
	"time"
)

type Locker interface {
	TryLock(ctx context.Context, key string, ttl time.Duration) bool
}

type Purger struct {
	Store *Store
	Lock  Locker
	Now   func() time.Time
}

var purgeMinute = 20

func nextPurgeRun(now time.Time) time.Time {
	now = now.UTC()
	candidate := time.Date(now.Year(), now.Month(), now.Day(), now.Hour(), purgeMinute, 0, 0, time.UTC)
	if candidate.After(now) {
		return candidate
	}
	return candidate.Add(time.Hour)
}

func (p *Purger) Run(ctx context.Context) {
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	for {
		wait := time.Until(nextPurgeRun(now()))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if p.Lock != nil && !p.Lock.TryLock(ctx, "resources:retention:purge", time.Hour) {
			continue
		}
		deleted, err := p.Store.PurgeExpiredAgents(ctx, now(), 500)
		if err != nil {
			slog.Warn("resource retention purge failed", "error", err)
			continue
		}
		if deleted > 0 {
			slog.Info("resource retention purge complete", "deleted_agents", deleted)
		}
	}
}
