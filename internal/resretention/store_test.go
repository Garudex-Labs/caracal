// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package resretention

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type stubRows struct {
	rows [][]any
	idx  int
}

func (r *stubRows) Close()                                       {}
func (r *stubRows) Err() error                                   { return nil }
func (r *stubRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *stubRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *stubRows) Next() bool                                   { r.idx++; return r.idx <= len(r.rows) }
func (r *stubRows) Values() ([]any, error)                       { return r.rows[r.idx-1], nil }
func (r *stubRows) RawValues() [][]byte                          { return nil }
func (r *stubRows) Conn() *pgx.Conn                              { return nil }

func (r *stubRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		switch dd := d.(type) {
		case *string:
			*dd = fmt.Sprint(row[i])
		case *int:
			*dd = row[i].(int)
		case *bool:
			*dd = row[i].(bool)
		case *time.Time:
			*dd = row[i].(time.Time)
		case **time.Time:
			if row[i] == nil {
				*dd = nil
			} else {
				t := row[i].(time.Time)
				*dd = &t
			}
		default:
			return fmt.Errorf("unsupported scan destination %T", d)
		}
	}
	return nil
}

type stubRow struct{ rows *stubRows }

func (r stubRow) Scan(dest ...any) error {
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

type stubDB struct {
	rows  *stubRows
	log   []string
	execs []string
}

func (db *stubDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	db.log = append(db.log, sql)
	copyRows := *db.rows
	copyRows.idx = 0
	return &copyRows, nil
}

func (db *stubDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	db.log = append(db.log, sql)
	copyRows := *db.rows
	copyRows.idx = 0
	return stubRow{rows: &copyRows}
}

func (db *stubDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.execs = append(db.execs, sql)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func TestPreviewPolicyChangeFindsReducedRetentionConflicts(t *testing.T) {
	deleted := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	current := deleted.AddDate(0, 0, 30)
	db := &stubDB{rows: &stubRows{rows: [][]any{{
		"a1", "Review Bot", "acme", "review-bot", "private", true, deleted, current,
	}}}}
	store := &Store{DB: db}
	conflicts, err := store.PreviewPolicyChange(context.Background(), uuid.New(),
		Policy{PrivateRetentionDays: 7, ProjectRetentionDays: 30}, deleted.AddDate(0, 0, 8))
	if err != nil {
		t.Fatal(err)
	}
	if len(conflicts) != 1 || !conflicts[0].EligibleAtApply {
		t.Fatalf("conflicts = %#v", conflicts)
	}
	if conflicts[0].ProposedScheduledPurgeAt != deleted.AddDate(0, 0, 7) {
		t.Fatalf("proposed = %s", conflicts[0].ProposedScheduledPurgeAt)
	}
}

func TestWritePolicyUpsertsAndReschedules(t *testing.T) {
	db := &stubDB{rows: &stubRows{}}
	store := &Store{DB: db}
	if err := store.WritePolicy(context.Background(), uuid.New(), Policy{PrivateRetentionDays: 10, ProjectRetentionDays: 20}); err != nil {
		t.Fatal(err)
	}
	if len(db.execs) != 2 || !strings.Contains(db.execs[0], "INSERT INTO project_resource_retention_policies") ||
		!strings.Contains(db.execs[1], "UPDATE agents") {
		t.Fatalf("execs = %#v", db.execs)
	}
}

func TestPurgeExpiredAgentsIsBoundedAndIdempotent(t *testing.T) {
	db := &stubDB{rows: &stubRows{rows: [][]any{{"a1"}, {"a2"}}}}
	store := &Store{DB: db}
	deleted, err := store.PurgeExpiredAgents(context.Background(), time.Now(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 2 || len(db.execs) != 2 || !strings.Contains(db.log[0], "LIMIT $2") || !strings.Contains(db.log[0], "DELETE FROM agents") {
		t.Fatalf("deleted=%d execs=%#v log=%#v", deleted, db.execs, db.log)
	}
}
