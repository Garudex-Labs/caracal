// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/registry"
)

// profileActivityDays is the window that decides which users have recent
// session activity worth a profile rebuild.
const profileActivityDays = 60

// Scheduler drives the recurring insight work: the weekly report discovery
// sweep and the daily user-profile refresh. Runs skip instead of stacking
// when the previous occurrence is still going.
type Scheduler struct {
	Service *Service
	// Profiles rebuilds cached work profiles.
	Profiles *registry.Store
	// now is a test seam.
	now func() time.Time

	batchBusy   sync.Mutex
	profileBusy sync.Mutex
}

func (s *Scheduler) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now().UTC()
}

// nextWeekly returns the next occurrence of the given UTC weekday and time.
func nextWeekly(now time.Time, weekday time.Weekday, hour, minute int) time.Time {
	now = now.UTC()
	next := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, time.UTC)
	daysAhead := (int(weekday) - int(now.Weekday()) + 7) % 7
	next = next.AddDate(0, 0, daysAhead)
	if !next.After(now) {
		next = next.AddDate(0, 0, 7)
	}
	return next
}

// nextDaily returns the next occurrence of the given UTC time of day.
func nextDaily(now time.Time, hour, minute int) time.Time {
	now = now.UTC()
	next := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, time.UTC)
	if !next.After(now) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}

// Start launches both schedules tied to ctx.
func (s *Scheduler) Start(ctx context.Context) {
	// Weekly discovery: Monday 06:00 UTC.
	go s.loop(ctx, "insight batch", func(now time.Time) time.Time {
		return nextWeekly(now, time.Monday, 6, 0)
	}, s.runBatch)
	// Daily profile refresh: 03:15 UTC.
	go s.loop(ctx, "profile refresh", func(now time.Time) time.Time {
		return nextDaily(now, 3, 15)
	}, s.runProfileRefresh)
	slog.Info("insight schedulers started")
}

// loop computes the next run instead of ticking, so drift and restarts
// never double-fire.
func (s *Scheduler) loop(ctx context.Context, name string, next func(time.Time) time.Time, run func(ctx context.Context)) {
	for {
		wait := time.Until(next(s.clock()))
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		slog.Info("scheduled job firing", "job", name)
		run(ctx)
	}
}

func (s *Scheduler) runBatch(ctx context.Context) {
	if !s.batchBusy.TryLock() {
		slog.Warn("insight batch still running; skipping this occurrence")
		return
	}
	defer s.batchBusy.Unlock()
	queued, err := s.Service.DiscoverAndQueue(ctx)
	if err != nil {
		slog.Error("insight batch sweep failed; next scheduled run retries", "error", err)
		return
	}
	if queued > 0 {
		slog.Info("insight batch queued reports", "count", queued)
	}
}

// runProfileRefresh rebuilds work profiles for users with recent session
// activity. Best-effort warm-up only: a skipped or failed user is rebuilt
// lazily on first request.
func (s *Scheduler) runProfileRefresh(ctx context.Context) {
	if !s.profileBusy.TryLock() {
		slog.Warn("profile refresh still running; skipping this occurrence")
		return
	}
	defer s.profileBusy.Unlock()

	active := s.activeUsers(ctx)
	if active == nil {
		slog.Warn("active-user lookup unavailable; sweeping every user")
	}

	rows, err := s.Service.Store.DB.Query(ctx,
		`SELECT id::text FROM users WHERE auth_provider != 'deactivated'`)
	if err != nil {
		slog.Error("profile refresh user list failed; next scheduled run retries", "error", err)
		return
	}
	userIDs := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			userIDs = append(userIDs, id)
		}
	}
	rows.Close()

	refreshed, skipped := 0, 0
	for _, id := range userIDs {
		if ctx.Err() != nil {
			return
		}
		if active != nil && !active[DefaultProjectID+"\x00"+id] {
			skipped++
			continue
		}
		userID, err := uuid.Parse(id)
		if err != nil {
			continue
		}
		// One bad user must not stop the sweep.
		if _, err := s.Profiles.GetOrBuildProfile(ctx, userID, DefaultProjectID, true); err != nil {
			slog.Warn("profile refresh failed for user", "user_id", id, "error", err)
			continue
		}
		refreshed++
	}
	slog.Info("user profiles refreshed", "count", refreshed, "skipped_inactive", skipped)
}

// activeUsers collects (project, user) pairs with a session in the window
// in one query, so idle accounts cost nothing. Nil - distinct from empty -
// means the lookup failed and the caller should sweep everyone.
func (s *Scheduler) activeUsers(ctx context.Context) map[string]bool {
	since := s.clock().Add(-profileActivityDays * 24 * time.Hour).Format("2006-01-02 15:04:05")
	rows, err := s.Service.Engine.CH.QueryJSON(ctx, `
		SELECT DISTINCT project_id, user_id
		FROM session_stats_agg FINAL
		WHERE last_event_time >= {since:String}
		  AND user_id != ''
		FORMAT JSON`, clickhouse.Settings{"param_since": since})
	if err != nil {
		return nil
	}
	active := map[string]bool{}
	for _, row := range rows {
		active[chString(row, "project_id")+"\x00"+chString(row, "user_id")] = true
	}
	return active
}
