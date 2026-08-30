// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fixedSettings int

func (f fixedSettings) Int(context.Context, string, int) int { return int(f) }

// TestPurgeOnceLive needs CARACAL_TEST_PG_URL; it seeds one stale resolved
// item, one stale open item, and one fresh resolved item, then proves only
// the stale resolved one is deleted.
func TestPurgeOnceLive(t *testing.T) {
	dsn := os.Getenv("CARACAL_TEST_PG_URL")
	if dsn == "" {
		t.Skip("CARACAL_TEST_PG_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM users ORDER BY created_at LIMIT 1`).Scan(&userID); err != nil {
		t.Skipf("no users seeded: %v", err)
	}
	longAgo := time.Now().UTC().AddDate(0, 0, -120)
	mk := func(state string, resolvedAt *time.Time) uuid.UUID {
		id := uuid.New()
		_, err := pool.Exec(ctx,
			`INSERT INTO inbox_items (id, user_id, kind, state, action_required, title,
			   subject_type, is_private_subject, dedupe_key, payload, created_at, resolved_at)
			 VALUES ($1, $2, 'system_notice', $3, false, 'purge-live-test', 'system', false, $4, '{}', $5, $6)`,
			id, userID, state, "purge-live:"+id.String(), longAgo, resolvedAt)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	staleDone := mk("done", &longAgo)
	staleOpen := mk("open", nil)
	fresh := time.Now().UTC()
	freshDone := mk("done", &fresh)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM inbox_items WHERE title = 'purge-live-test'`)
	})

	p := &Purger{DB: pool, Settings: fixedSettings(90)}
	deleted, err := p.PurgeOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if deleted < 1 {
		t.Fatalf("deleted = %d, want >= 1", deleted)
	}
	var n int
	for _, tc := range []struct {
		id   uuid.UUID
		want int
		name string
	}{{staleDone, 0, "stale resolved purged"}, {staleOpen, 1, "open never purged"}, {freshDone, 1, "fresh resolved kept"}} {
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM inbox_items WHERE id = $1`, tc.id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != tc.want {
			t.Errorf("%s: rows = %d, want %d", tc.name, n, tc.want)
		}
	}

	// Retention disabled must be a no-op.
	off := &Purger{DB: pool, Settings: fixedSettings(0)}
	if deleted, err := off.PurgeOnce(ctx); err != nil || deleted != 0 {
		t.Errorf("disabled retention purged %d (err %v)", deleted, err)
	}
}
