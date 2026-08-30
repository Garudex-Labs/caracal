// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

func TestNextWeekly(t *testing.T) {
	// Wednesday 2026-08-26 10:00 UTC; next Monday 06:00 is 2026-08-31.
	now := time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)
	got := nextWeekly(now, time.Monday, 6, 0)
	want := time.Date(2026, 8, 31, 6, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("nextWeekly = %v, want %v", got, want)
	}
	// Exactly at the trigger instant, the next occurrence is a week out.
	atTrigger := time.Date(2026, 8, 31, 6, 0, 0, 0, time.UTC)
	got = nextWeekly(atTrigger, time.Monday, 6, 0)
	if !got.Equal(atTrigger.AddDate(0, 0, 7)) {
		t.Errorf("at-trigger nextWeekly = %v", got)
	}
	// Earlier the same day still fires today.
	monMorning := time.Date(2026, 8, 31, 5, 0, 0, 0, time.UTC)
	if got = nextWeekly(monMorning, time.Monday, 6, 0); !got.Equal(atTrigger) {
		t.Errorf("same-day nextWeekly = %v", got)
	}
}

func TestNextDaily(t *testing.T) {
	before := time.Date(2026, 8, 26, 2, 0, 0, 0, time.UTC)
	if got := nextDaily(before, 3, 15); !got.Equal(time.Date(2026, 8, 26, 3, 15, 0, 0, time.UTC)) {
		t.Errorf("before = %v", got)
	}
	after := time.Date(2026, 8, 26, 4, 0, 0, 0, time.UTC)
	if got := nextDaily(after, 3, 15); !got.Equal(time.Date(2026, 8, 27, 3, 15, 0, 0, time.UTC)) {
		t.Errorf("after = %v", got)
	}
}

func TestSchedulerClock(t *testing.T) {
	fixed := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	s := &Scheduler{now: func() time.Time { return fixed }}
	if !s.clock().Equal(fixed) {
		t.Errorf("seamed clock = %v", s.clock())
	}
	real := &Scheduler{}
	if d := time.Since(real.clock()); d < 0 || d > time.Minute {
		t.Errorf("default clock drift = %v", d)
	}
}

func schedulerWith(db *fakeDB, ch *fakeCH, cfg cfgMap) *Scheduler {
	engine := &Engine{DB: db, CH: ch, Config: &Config{Settings: cfg}, LLM: &recordingCompleter{}}
	return &Scheduler{
		Service: NewService(engine, &Store{DB: db}, 1),
		now:     func() time.Time { return time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC) },
	}
}

func TestActiveUsers(t *testing.T) {
	ch := &fakeCH{fn: func(_ int, _ string, _ clickhouse.Settings) ([]map[string]any, error) {
		return []map[string]any{{"project_id": "default", "user_id": "u1"}}, nil
	}}
	s := schedulerWith(&fakeDB{}, ch, cfgMap{})
	active := s.activeUsers(context.Background())
	if !active["default\x00u1"] || len(active) != 1 {
		t.Errorf("active = %v", active)
	}
	// The since parameter reflects the activity window from the seam.
	since := ch.settings[0]["param_since"]
	if since != "2026-06-27 00:00:00" {
		t.Errorf("param_since = %v", since)
	}

	broken := schedulerWith(&fakeDB{}, &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, errors.New("ch down")
	}}, cfgMap{})
	if got := broken.activeUsers(context.Background()); got != nil {
		t.Errorf("lookup failure must return nil, got %v", got)
	}
}

func TestRunBatchDisabled(t *testing.T) {
	db := &fakeDB{}
	s := schedulerWith(db, &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, errors.New("unused")
	}}, cfgMap{bools: map[string]bool{"insights.batch_enabled": false}})
	s.runBatch(context.Background())
	if got := db.sqlCalls("INSERT INTO insight_reports"); len(got) != 0 {
		t.Errorf("disabled batch queued reports: %d", len(got))
	}
}

func TestRunBatchSkipsWhenBusy(t *testing.T) {
	db := &fakeDB{queryErr: map[string]error{"FROM agents a": errors.New("must not be reached")}}
	s := schedulerWith(db, &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, nil
	}}, cfgMap{})
	s.batchBusy.Lock()
	defer s.batchBusy.Unlock()
	s.runBatch(context.Background())
	if got := db.sqlCalls("FROM agents a"); len(got) != 0 {
		t.Errorf("busy batch must skip: %v", got)
	}
}

func TestRunProfileRefreshEmptyUserList(t *testing.T) {
	db := &fakeDB{}
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, errors.New("ch down")
	}}
	s := schedulerWith(db, ch, cfgMap{})
	s.runProfileRefresh(context.Background())
	if got := db.sqlCalls("FROM users WHERE auth_provider"); len(got) != 1 {
		t.Errorf("user sweep queries = %d", len(got))
	}
}

func TestRunProfileRefreshUserListFailure(t *testing.T) {
	db := &fakeDB{queryErr: map[string]error{"auth_provider": errors.New("db down")}}
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, nil
	}}
	s := schedulerWith(db, ch, cfgMap{})
	s.runProfileRefresh(context.Background())
}

func TestRunProfileRefreshSkipsBusy(t *testing.T) {
	db := &fakeDB{queryErr: map[string]error{"auth_provider": errors.New("must not be reached")}}
	s := schedulerWith(db, &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, nil
	}}, cfgMap{})
	s.profileBusy.Lock()
	defer s.profileBusy.Unlock()
	s.runProfileRefresh(context.Background())
	if got := db.sqlCalls("auth_provider"); len(got) != 0 {
		t.Errorf("busy refresh must skip: %v", got)
	}
}

func TestRunProfileRefreshSkipsInactiveUsers(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "auth_provider", rows: &fakeRows{rows: [][]any{{testOwnerID}, {"not-a-uuid"}}}},
	}}
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		// Someone else is active; the listed users are not.
		return []map[string]any{{"project_id": "default", "user_id": "someone-else"}}, nil
	}}
	s := schedulerWith(db, ch, cfgMap{})
	// Profiles is never touched because every user is inactive.
	s.runProfileRefresh(context.Background())
}

func TestSchedulerStartExitsWithContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := schedulerWith(&fakeDB{}, &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, nil
	}}, cfgMap{})
	s.Start(ctx)
}
