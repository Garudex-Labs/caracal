// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// liveTx opens a transaction against CARACAL_TEST_PG_URL that is always
// rolled back, so delivery invariants run against the real schema without
// leaving residue.
func liveTx(t *testing.T) (context.Context, pgx.Tx, uuid.UUID) {
	t.Helper()
	dsn := os.Getenv("CARACAL_TEST_PG_URL")
	if dsn == "" {
		t.Skip("CARACAL_TEST_PG_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	var userID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM users ORDER BY created_at LIMIT 1`).Scan(&userID); err != nil {
		t.Skipf("no users seeded: %v", err)
	}
	return ctx, tx, userID
}

func itemState(t *testing.T, ctx context.Context, tx pgx.Tx, id uuid.UUID) (state string, title string) {
	t.Helper()
	if err := tx.QueryRow(ctx, `SELECT state, title FROM inbox_items WHERE id = $1`, id).Scan(&state, &title); err != nil {
		t.Fatal(err)
	}
	return state, title
}

func TestLiveSameFactDeliveredTwiceCreatesOneRow(t *testing.T) {
	ctx, tx, userID := liveTx(t)
	subject := subjectFor(t, "review-bot")

	first, err := DeliverOne(ctx, tx, "review_requested", userID, subject, nil, nil, nil, nil)
	if err != nil || first == nil {
		t.Fatalf("first delivery = %v, %v", first, err)
	}
	second, err := DeliverOne(ctx, tx, "review_requested", userID, subject, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("redelivery must be absorbed, got %v", err)
	}
	if second != nil {
		t.Fatalf("redelivery returned a new item %v", second)
	}
	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM inbox_items WHERE user_id = $1 AND subject_id = $2`, userID, subject.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows = %d, want 1", n)
	}
}

func TestLiveCollisionDoesNotPoisonTheBatch(t *testing.T) {
	ctx, tx, userID := liveTx(t)
	subject := subjectFor(t, "review-bot")

	if _, err := DeliverOne(ctx, tx, "review_requested", userID, subject, nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	// The collision is recovered in a savepoint...
	if _, err := DeliverOne(ctx, tx, "review_requested", userID, subject, nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	// ...so the enclosing transaction keeps accepting new work.
	next, err := DeliverOne(ctx, tx, "review_approved", userID, subject, nil, nil, nil, nil)
	if err != nil || next == nil {
		t.Fatalf("batch poisoned after collision: %v, %v", next, err)
	}
}

func TestLiveRedeliveryReopensAResolvedItem(t *testing.T) {
	ctx, tx, userID := liveTx(t)
	subject := subjectFor(t, "review-bot")

	id, err := DeliverOne(ctx, tx, "review_requested", userID, subject, nil, nil, nil, nil)
	if err != nil || id == nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE inbox_items SET state = 'done', resolved_at = now() WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	reopened, err := DeliverOne(ctx, tx, "review_requested", userID, subject, nil, nil, nil, nil)
	if err != nil || reopened == nil || *reopened != *id {
		t.Fatalf("reopened = %v, %v; want the resolved item back", reopened, err)
	}
	state, _ := itemState(t, ctx, tx, *id)
	if state != "open" {
		t.Fatalf("state = %q, want open", state)
	}
	var events int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM inbox_item_events WHERE item_id = $1 AND event = 'reopened'`, id).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("reopened events = %d, want 1", events)
	}
}

func TestLiveDismissedNonReopeningKindStaysDismissed(t *testing.T) {
	ctx, tx, userID := liveTx(t)
	subject := subjectFor(t, "review-bot")
	context := map[string]any{"comment_id": "c-1"}

	id, err := DeliverOne(ctx, tx, "review_comment", userID, subject, nil, nil, context, nil)
	if err != nil || id == nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE inbox_items SET state = 'dismissed', resolved_at = now() WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	again, err := DeliverOne(ctx, tx, "review_comment", userID, subject, nil, nil, context, nil)
	if err != nil || again != nil {
		t.Fatalf("redelivery = %v, %v; a dismissed comment stays dismissed", again, err)
	}
	if state, _ := itemState(t, ctx, tx, *id); state != "dismissed" {
		t.Fatalf("state = %q, want dismissed", state)
	}
}

func TestLiveOpenItemContentRefreshesOnRedelivery(t *testing.T) {
	ctx, tx, userID := liveTx(t)
	subject := subjectFor(t, "review-bot")

	id, err := DeliverOne(ctx, tx, "review_requested", userID, subject, nil, nil, nil, nil)
	if err != nil || id == nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE inbox_items SET read_at = now() WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	renamed := subject
	renamed.Name = "review-bot-renamed"
	if again, err := DeliverOne(ctx, tx, "review_requested", userID, renamed, nil, nil, nil, nil); err != nil || again != nil {
		t.Fatalf("refresh redelivery = %v, %v", again, err)
	}
	_, title := itemState(t, ctx, tx, *id)
	if title != "Review requested: review-bot-renamed v1.2.0" {
		t.Fatalf("title = %q, want refreshed content", title)
	}
	var readAt *string
	if err := tx.QueryRow(ctx, `SELECT read_at::text FROM inbox_items WHERE id = $1`, id).Scan(&readAt); err != nil {
		t.Fatal(err)
	}
	if readAt != nil {
		t.Fatal("a refreshed item must surface as unread again")
	}
}

func TestLiveResolveMatchingClosesEveryOpenCopy(t *testing.T) {
	ctx, tx, userID := liveTx(t)
	subject := subjectFor(t, "review-bot")

	id, err := DeliverOne(ctx, tx, "review_requested", userID, subject, nil, nil, nil, nil)
	if err != nil || id == nil {
		t.Fatal(err)
	}
	spec := kindSpecs["review_requested"]
	closed, err := ResolveMatching(ctx, tx, "review_requested", spec.dedupe(subject, nil), "decision recorded", nil)
	if err != nil || closed != 1 {
		t.Fatalf("closed = %d, %v", closed, err)
	}
	if state, _ := itemState(t, ctx, tx, *id); state != "done" {
		t.Fatalf("state = %q, want done", state)
	}
}
