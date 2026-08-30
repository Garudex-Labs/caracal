// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// SettingsReader resolves the retention horizon at each run.
type SettingsReader interface {
	Int(ctx context.Context, key string, fallback int) int
}

// PurgeLocker serializes the purge across replicas.
type PurgeLocker interface {
	TryLock(ctx context.Context, key string, ttl time.Duration) bool
}

// PurgeDB is the pool surface the purge needs.
type PurgeDB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Purger deletes resolved inbox items past the retention horizon. Only
// done and dismissed items are eligible: an open item is unactioned work,
// and deleting work silently is the exact failure the inbox exists to
// prevent, so it is never purged on age.
type Purger struct {
	DB       PurgeDB
	Settings SettingsReader
	Lock     PurgeLocker
	Now      func() time.Time
}

// purgeAt is the daily UTC run time.
var purgeAt = struct{ hour, minute int }{4, 45}

func nextPurgeRun(now time.Time) time.Time {
	now = now.UTC()
	candidate := time.Date(now.Year(), now.Month(), now.Day(), purgeAt.hour, purgeAt.minute, 0, 0, time.UTC)
	if candidate.After(now) {
		return candidate
	}
	return candidate.AddDate(0, 0, 1)
}

// Run sleeps between scheduled purges until the context ends.
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
		if p.Lock != nil && !p.Lock.TryLock(ctx, "inbox:purge", time.Hour) {
			continue
		}
		if deleted, err := p.PurgeOnce(ctx); err != nil {
			slog.Warn("inbox purge failed", "error", err)
		} else if deleted > 0 {
			slog.Info("inbox purge", "deleted", deleted)
		}
	}
}

// PurgeOnce applies the retention policy one time and reports the count.
// The eligibility predicates live in the DELETE itself: a user can reopen
// an item concurrently, and deleting by pre-gathered ids would destroy
// work they just pulled back into their queue.
func (p *Purger) PurgeOnce(ctx context.Context) (int, error) {
	retentionDays := 90
	if p.Settings != nil {
		retentionDays = p.Settings.Int(ctx, "inbox.retention_days", 90)
	}
	if retentionDays <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -retentionDays)
	tag, err := p.DB.Exec(ctx,
		`DELETE FROM inbox_items
		 WHERE state IN ('done', 'dismissed') AND resolved_at IS NOT NULL AND resolved_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
