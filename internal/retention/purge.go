// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package retention

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// Locker guards the purge so only one instance runs it per window.
type Locker interface {
	TryLock(ctx context.Context, key string, ttl time.Duration) bool
}

// Purger runs the configured retention policy on its six-hour schedule.
type Purger struct {
	Store *Store
	Lock  Locker
	// Now is stubbed in tests.
	Now func() time.Time
}

// purgeHours are the UTC run hours; the purge fires at half past.
var purgeHours = []int{1, 7, 13, 19}

// nextRun returns the next scheduled purge time after now.
func nextRun(now time.Time) time.Time {
	now = now.UTC()
	for _, h := range purgeHours {
		candidate := time.Date(now.Year(), now.Month(), now.Day(), h, 30, 0, 0, time.UTC)
		if candidate.After(now) {
			return candidate
		}
	}
	next := now.AddDate(0, 0, 1)
	return time.Date(next.Year(), next.Month(), next.Day(), purgeHours[0], 30, 0, 0, time.UTC)
}

// Run sleeps between scheduled purges until the context ends.
func (p *Purger) Run(ctx context.Context) {
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	for {
		wait := time.Until(nextRun(now()))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if p.Lock != nil && !p.Lock.TryLock(ctx, "retention:purge", time.Hour) {
			continue
		}
		if err := p.Store.Purge(ctx); err != nil {
			slog.Warn("retention purge failed", "error", err)
		}
	}
}

// Purge applies the retention policy once: time-based trace deletion with
// aggregate orphan cleanup, report expiry, then the count ceiling.
func (s *Store) Purge(ctx context.Context) error {
	if !s.Settings.Bool(ctx, "retention.enabled", false) {
		return nil
	}
	traceDays := s.Settings.Int(ctx, "retention.trace_days", 0)
	scoreDays := s.Settings.Int(ctx, "retention.score_days", 0)
	maxTraces := s.Settings.Int(ctx, "retention.max_trace_count", 0)
	if traceDays == 0 && scoreDays == 0 && maxTraces == 0 {
		return nil
	}
	if !s.hasData(ctx) {
		return nil
	}
	if s.hasInflightInsights(ctx) {
		slog.Info("skipping retention purge while insights are in flight")
		return nil
	}

	now := time.Now().UTC()
	if traceDays > 0 {
		cutoff := now.AddDate(0, 0, -traceDays).Format("2006-01-02 15:04:05.000")
		if err := s.deleteBefore(ctx, cutoff); err != nil {
			slog.Warn("retention trace purge failed", "error", err)
		}
		s.purgeAggregateOrphans(ctx)
	}
	if scoreDays == 0 && traceDays > 0 {
		scoreDays = traceDays * 2
	}
	if scoreDays > 0 {
		horizon := scoreDays
		if horizon < 30 {
			horizon = 30
		}
		s.purgeReports(ctx, now.AddDate(0, 0, -horizon))
	}
	if maxTraces > 0 {
		s.purgeOverCount(ctx, maxTraces)
	}
	slog.Info("retention purge complete")
	return nil
}

func (s *Store) hasData(ctx context.Context) bool {
	rows, err := s.CH.QueryJSON(ctx,
		"SELECT 1 AS one FROM session_events WHERE project_id = {pid:String} LIMIT 1 FORMAT JSON",
		clickhouse.Settings{"param_pid": DefaultProjectID})
	return err == nil && len(rows) > 0
}

func (s *Store) hasInflightInsights(ctx context.Context) bool {
	var id string
	err := s.DB.QueryRow(ctx,
		`SELECT id::text FROM insight_reports WHERE status IN ('pending', 'running') LIMIT 1`).Scan(&id)
	return err == nil
}

func (s *Store) deleteBefore(ctx context.Context, cutoff string) error {
	return s.CH.Exec(ctx,
		"DELETE FROM session_events "+
			"WHERE project_id = {pid:String} AND timestamp < {cutoff:String} "+
			"SETTINGS lightweight_deletes_sync = 0",
		clickhouse.Settings{"param_pid": DefaultProjectID, "param_cutoff": cutoff})
}

func (s *Store) purgeAggregateOrphans(ctx context.Context) {
	_ = s.CH.Exec(ctx,
		"DELETE FROM session_stats_agg "+
			"WHERE project_id = {pid:String} "+
			"AND session_id NOT IN ("+
			"  SELECT DISTINCT session_id FROM session_events WHERE project_id = {pid2:String}"+
			") SETTINGS lightweight_deletes_sync = 0",
		clickhouse.Settings{"param_pid": DefaultProjectID, "param_pid2": DefaultProjectID})
}

func (s *Store) purgeReports(ctx context.Context, cutoff time.Time) {
	_, _ = s.DB.Exec(ctx,
		`DELETE FROM insight_reports WHERE completed_at < $1 AND status = 'completed'`, cutoff)
	_, _ = s.DB.Exec(ctx,
		`DELETE FROM insight_reports WHERE created_at < $1 AND status IN ('failed', 'pending')`, cutoff)
}

// purgeOverCount walks daily distinct-session counts newest-first and
// deletes everything older than the day the running total crosses the cap.
func (s *Store) purgeOverCount(ctx context.Context, maxTraces int) {
	rows, err := s.CH.QueryJSON(ctx,
		"SELECT toDate(timestamp) AS day, count(DISTINCT session_id) AS cnt "+
			"FROM session_events WHERE project_id = {pid:String} "+
			"AND timestamp >= now() - INTERVAL 730 DAY "+
			"GROUP BY day ORDER BY day DESC LIMIT 730 FORMAT JSON",
		clickhouse.Settings{"param_pid": DefaultProjectID})
	if err != nil {
		return
	}
	var running int64
	cutoffDay := ""
	for _, r := range rows {
		running += chInt(r, "cnt")
		if running > int64(maxTraces) {
			cutoffDay, _ = r["day"].(string)
			break
		}
	}
	if cutoffDay == "" {
		return
	}
	_ = s.deleteBefore(ctx, fmt.Sprintf("%s 00:00:00.000", cutoffDay))
	s.purgeAggregateOrphans(ctx)
}
