// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type purgeFakeDB struct {
	tag  pgconn.CommandTag
	err  error
	sqls []string
}

func (db *purgeFakeDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.sqls = append(db.sqls, sql)
	return db.tag, db.err
}

type cancelLock struct {
	calls  int
	cancel context.CancelFunc
}

func (l *cancelLock) TryLock(context.Context, string, time.Duration) bool {
	l.calls++
	if l.calls == 1 {
		return true
	}
	l.cancel()
	return false
}

func TestNextPurgeRun(t *testing.T) {
	before := time.Date(2026, 8, 30, 4, 0, 0, 0, time.UTC)
	if got := nextPurgeRun(before); got != time.Date(2026, 8, 30, 4, 45, 0, 0, time.UTC) {
		t.Errorf("before the slot: %v", got)
	}
	after := time.Date(2026, 8, 30, 5, 0, 0, 0, time.UTC)
	if got := nextPurgeRun(after); got != time.Date(2026, 8, 31, 4, 45, 0, 0, time.UTC) {
		t.Errorf("after the slot: %v", got)
	}
	// Exactly at the slot rolls to the next day: candidate is not After now.
	at := time.Date(2026, 8, 30, 4, 45, 0, 0, time.UTC)
	if got := nextPurgeRun(at); got != time.Date(2026, 8, 31, 4, 45, 0, 0, time.UTC) {
		t.Errorf("at the slot: %v", got)
	}
}

func TestPurgeOnce(t *testing.T) {
	db := &purgeFakeDB{tag: pgconn.NewCommandTag("DELETE 3")}
	deleted, err := (&Purger{DB: db}).PurgeOnce(context.Background())
	if err != nil || deleted != 3 {
		t.Fatalf("deleted = %d, err = %v", deleted, err)
	}
	// Only resolved items are eligible; the predicate lives in the DELETE.
	if !strings.Contains(db.sqls[0], "state IN ('done', 'dismissed')") ||
		!strings.Contains(db.sqls[0], "resolved_at IS NOT NULL") {
		t.Errorf("eligibility predicate missing:\n%s", db.sqls[0])
	}
}

func TestPurgeOnceDisabledRetention(t *testing.T) {
	db := &purgeFakeDB{}
	p := &Purger{DB: db, Settings: fixedSettings(0)}
	deleted, err := p.PurgeOnce(context.Background())
	if err != nil || deleted != 0 {
		t.Fatalf("deleted = %d, err = %v", deleted, err)
	}
	if len(db.sqls) != 0 {
		t.Errorf("disabled retention still deleted: %v", db.sqls)
	}
}

func TestPurgeOnceError(t *testing.T) {
	db := &purgeFakeDB{err: errors.New("pool down")}
	if _, err := (&Purger{DB: db, Settings: fixedSettings(30)}).PurgeOnce(context.Background()); err == nil {
		t.Fatal("exec failure must propagate")
	}
}

func TestPurgerRunPurgesThenStops(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	lock := &cancelLock{cancel: cancel}
	db := &purgeFakeDB{tag: pgconn.NewCommandTag("DELETE 2")}
	past := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	p := &Purger{DB: db, Lock: lock, Now: func() time.Time { return past }}

	done := make(chan struct{})
	go func() {
		p.Run(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("Run did not stop after context cancellation")
	}
	if lock.calls < 2 {
		t.Fatalf("lock calls = %d, want at least two scheduled runs", lock.calls)
	}
	if len(db.sqls) == 0 {
		t.Fatal("locked run never purged")
	}
}

func TestPurgerRunReportsFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	lock := &cancelLock{cancel: cancel}
	db := &purgeFakeDB{err: errors.New("pool down")}
	past := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	p := &Purger{DB: db, Lock: lock, Now: func() time.Time { return past }}

	done := make(chan struct{})
	go func() {
		p.Run(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("Run did not stop after context cancellation")
	}
}
