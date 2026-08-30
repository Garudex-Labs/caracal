// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

var dedupeConstraintErr = &pgconn.PgError{ConstraintName: "uq_inbox_items_user_dedupe"}

func TestDeliverOneInsertsAndRecordsEvent(t *testing.T) {
	tx := &fakeTx{}
	subject := subjectFor(t, "review-bot")
	actor := uuid.New()
	id, err := DeliverOne(context.Background(), tx, "review_requested", inboxUser, subject, &actor, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if id == nil {
		t.Fatal("new delivery must return the item id")
	}
	if tx.countLog("INSERT INTO inbox_items") != 1 || tx.countLog("INSERT INTO inbox_item_events") != 1 {
		t.Errorf("statements: %v", tx.log)
	}
	if tx.commits != 1 {
		t.Errorf("savepoint commits = %d", tx.commits)
	}
}

func TestDeliverOneActionRequiredOverride(t *testing.T) {
	tx := &fakeTx{}
	subject := subjectFor(t, "review-bot")
	override := false
	if _, err := DeliverOne(context.Background(), tx, "review_requested", inboxUser, subject,
		nil, nil, nil, &override); err != nil {
		t.Fatal(err)
	}
	for i, sql := range tx.log {
		if strings.Contains(sql, "INSERT INTO inbox_items ") {
			if tx.args[i][3] != false {
				t.Errorf("action_required = %v, want the override", tx.args[i][3])
			}
			return
		}
	}
	t.Fatal("insert not issued")
}

func TestDeliverOneSavepointBeginError(t *testing.T) {
	tx := &fakeTx{beginErr: errors.New("no savepoint")}
	_, err := DeliverOne(context.Background(), tx, "review_requested", inboxUser, subjectFor(t, "x"), nil, nil, nil, nil)
	if err == nil {
		t.Fatal("savepoint failure must propagate")
	}
}

func TestDeliverOneInsertErrorPropagates(t *testing.T) {
	tx := &fakeTx{execs: []txExec{
		{match: "INSERT INTO inbox_items ", err: errors.New("disk full")},
	}}
	_, err := DeliverOne(context.Background(), tx, "review_requested", inboxUser, subjectFor(t, "x"), nil, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("err = %v", err)
	}
	if tx.rollbacks == 0 {
		t.Error("failed savepoint was not rolled back")
	}
}

func TestDeliverOneDuplicateUpdatesOpenItem(t *testing.T) {
	existing := uuid.New()
	tx := &fakeTx{
		execs: []txExec{{match: "INSERT INTO inbox_items ", err: dedupeConstraintErr}},
		stubs: []stub{
			{match: "AND dedupe_key = $2", rows: &fakeRows{rows: [][]any{
				{existing, "open", "stale title", nil, nil, nil, "{}"},
			}}},
		},
	}
	id, err := DeliverOne(context.Background(), tx, "review_requested", inboxUser, subjectFor(t, "review-bot"),
		nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if id != nil {
		t.Fatalf("open redelivery must be absorbed, got id %v", id)
	}
	if tx.countLog("SET title = $2") != 1 || tx.countLog("SET read_at = NULL") != 1 {
		t.Errorf("open duplicate must refresh and re-unread: %v", tx.log)
	}
}

func TestDeliverOneDuplicateResurrectsResolvedItem(t *testing.T) {
	existing := uuid.New()
	tx := &fakeTx{
		execs: []txExec{{match: "INSERT INTO inbox_items ", err: dedupeConstraintErr}},
		stubs: []stub{
			{match: "AND dedupe_key = $2", rows: &fakeRows{rows: [][]any{
				{existing, "done", "stale title", nil, nil, nil, "{}"},
			}}},
		},
	}
	id, err := DeliverOne(context.Background(), tx, "review_requested", inboxUser, subjectFor(t, "review-bot"),
		nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if id == nil || *id != existing {
		t.Fatalf("resurrected id = %v, want %s", id, existing)
	}
	if tx.countLog("SET state = 'open'") != 1 {
		t.Errorf("resolved duplicate must reopen: %v", tx.log)
	}
}

func TestDeliverOneDuplicateAbsorbedWhenKindDoesNotReopen(t *testing.T) {
	existing := uuid.New()
	subject := subjectFor(t, "review-bot")
	// The stored row matches exactly what redelivery would write, so
	// nothing changes and review_comment does not resurrect.
	tx := &fakeTx{
		execs: []txExec{{match: "INSERT INTO inbox_items ", err: dedupeConstraintErr}},
		stubs: []stub{
			{match: "AND dedupe_key = $2", rows: &fakeRows{rows: [][]any{
				{existing, "done", "New comment on review-bot", nil, nil, nil, `{"comment_id":"c1"}`},
			}}},
		},
	}
	id, err := DeliverOne(context.Background(), tx, "review_comment", inboxUser, subject,
		nil, nil, map[string]any{"comment_id": "c1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if id != nil {
		t.Fatalf("non-reopening duplicate returned id %v", id)
	}
	if tx.countLog("SET state = 'open'") != 0 || tx.countLog("SET title = $2") != 0 {
		t.Errorf("absorbed duplicate must not write: %v", tx.log)
	}
}

func TestDeliverOneDuplicateRowGone(t *testing.T) {
	// Constraint fired but the row vanished before the lookup (concurrent
	// purge): the redelivery is dropped without error.
	tx := &fakeTx{
		execs: []txExec{{match: "INSERT INTO inbox_items ", err: dedupeConstraintErr}},
	}
	id, err := DeliverOne(context.Background(), tx, "review_requested", inboxUser, subjectFor(t, "x"),
		nil, nil, nil, nil)
	if err != nil || id != nil {
		t.Fatalf("id = %v, err = %v", id, err)
	}
}

func TestDeliverCountsNewDeliveries(t *testing.T) {
	tx := &fakeTx{}
	subject := subjectFor(t, "review-bot")
	u1, u2 := uuid.New(), uuid.New()
	delivered, err := Deliver(context.Background(), tx, "review_requested",
		[]uuid.UUID{u1, u2, u1}, subject, nil, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if delivered != 2 {
		t.Fatalf("delivered = %d, want one per distinct recipient", delivered)
	}
}

func TestResolveMatchingClosesEveryOpenCopy(t *testing.T) {
	id1, id2 := uuid.New(), uuid.New()
	tx := &fakeTx{stubs: []stub{
		{match: "state = 'open'", rows: &fakeRows{rows: [][]any{{id1}, {id2}}}},
	}}
	detail := "Submission withdrawn"
	n, err := ResolveMatching(context.Background(), tx, "review_requested", "key", detail, nil)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("resolved = %d", n)
	}
	if tx.countLog("SET state = 'done'") != 2 || tx.countLog("INSERT INTO inbox_item_events") != 2 {
		t.Errorf("statements: %v", tx.log)
	}
}

func TestResolveMatchingExecError(t *testing.T) {
	tx := &fakeTx{
		stubs: []stub{{match: "state = 'open'", rows: &fakeRows{rows: [][]any{{uuid.New()}}}}},
		execs: []txExec{{match: "SET state = 'done'", err: errors.New("write failed")}},
	}
	if _, err := ResolveMatching(context.Background(), tx, "k", "d", "detail", nil); err == nil {
		t.Fatal("exec failure must propagate")
	}
}

func TestGlobalReviewers(t *testing.T) {
	u1, u2 := uuid.New(), uuid.New()
	db := &fakeDB{stubs: []stub{
		{match: "FROM users", rows: &fakeRows{rows: [][]any{{u1}, {u2}}}},
	}}
	ids, err := GlobalReviewers(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != u1 || ids[1] != u2 {
		t.Fatalf("ids = %v", ids)
	}
	// Review capability is role-based: reviewer plus the operator role.
	if !strings.Contains(db.log[0], "'reviewer', 'operator'") {
		t.Errorf("reviewer roles changed:\n%s", db.log[0])
	}
}

func TestDedupeKeyFor(t *testing.T) {
	subject := subjectFor(t, "review-bot")
	key, err := DedupeKeyFor("review_requested", subject, nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := "review_requested:agent:" + subject.ID.String() + ":v1.2.0"; key != want {
		t.Errorf("key = %q, want %q", key, want)
	}
	if _, err := DedupeKeyFor("no-such-kind", subject, nil); err == nil {
		t.Fatal("unknown kind must error")
	}
}

func TestSubjectProjectionFallbacks(t *testing.T) {
	id := uuid.New()
	slug := "tool"
	if got := (Subject{Name: "n", Slug: &slug}).label(); got != "n" {
		t.Errorf("name label = %q", got)
	}
	if got := (Subject{Slug: &slug}).label(); got != "tool" {
		t.Errorf("slug label = %q", got)
	}
	if got := (Subject{ID: &id}).label(); got != id.String() {
		t.Errorf("id label = %q", got)
	}
	if got := (Subject{}).label(); got != "item" {
		t.Errorf("empty label = %q", got)
	}

	unversioned := Subject{Name: "n"}
	if unversioned.versioned() != "n" || unversioned.versionKey() != "-" {
		t.Errorf("unversioned projections: %q %q", unversioned.versioned(), unversioned.versionKey())
	}

	if got := ctxStr(map[string]any{"k": "v"}, "k", "fallback"); got != "v" {
		t.Errorf("ctxStr hit = %q", got)
	}
	if got := ctxStr(map[string]any{"k": 7}, "k", "fallback"); got != "fallback" {
		t.Errorf("ctxStr non-string = %q", got)
	}
}
