// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeRows is an in-process pgx.Rows implementation for pgExistingTables.
type fakeRows struct {
	rows     [][]any
	idx      int
	scanErr  error
	afterErr error
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return r.afterErr }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }

func (r *fakeRows) Next() bool {
	if r.idx >= len(r.rows) {
		return false
	}
	r.idx++
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	row := r.rows[r.idx-1]
	for i := range dest {
		if p, ok := dest[i].(*string); ok {
			*p = row[i].(string)
		}
	}
	return nil
}

func (r *fakeRows) Values() ([]any, error) { return r.rows[r.idx-1], nil }

// fakeQuerier satisfies the anonymous querier interface pgExistingTables takes.
type fakeQuerier struct {
	rows     *fakeRows
	queryErr error
}

func (q *fakeQuerier) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if q.queryErr != nil {
		return nil, q.queryErr
	}
	return q.rows, nil
}

func TestPGExistingTables(t *testing.T) {
	ctx := context.Background()

	q := &fakeQuerier{rows: &fakeRows{rows: [][]any{{"users"}, {"agents"}}}}
	existing, err := pgExistingTables(ctx, q)
	if err != nil {
		t.Fatalf("pgExistingTables: %v", err)
	}
	if len(existing) != 2 || !existing["users"] || !existing["agents"] {
		t.Fatalf("existing = %v", existing)
	}

	if _, err := pgExistingTables(ctx, &fakeQuerier{queryErr: errors.New("boom")}); err == nil {
		t.Fatal("a query error must propagate")
	}

	scanFail := &fakeQuerier{rows: &fakeRows{rows: [][]any{{"users"}}, scanErr: errors.New("scan")}}
	if _, err := pgExistingTables(ctx, scanFail); err == nil {
		t.Fatal("a scan error must propagate")
	}

	lateFail := &fakeQuerier{rows: &fakeRows{afterErr: errors.New("late")}}
	if _, err := pgExistingTables(ctx, lateFail); err == nil {
		t.Fatal("a deferred rows.Err() must propagate")
	}
}
