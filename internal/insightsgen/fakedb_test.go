// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ── package-local pgx fake (routing by SQL substring, first match wins) ──

type fakeRows struct {
	cols []string
	rows [][]any
	idx  int
	err  error
}

func (r *fakeRows) Close()                        {}
func (r *fakeRows) Err() error                    { return r.err }
func (r *fakeRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription {
	out := make([]pgconn.FieldDescription, len(r.cols))
	for i, c := range r.cols {
		out[i] = pgconn.FieldDescription{Name: c}
	}
	return out
}
func (r *fakeRows) Next() bool             { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Values() ([]any, error) { return r.rows[r.idx-1], nil }
func (r *fakeRows) RawValues() [][]byte    { return nil }
func (r *fakeRows) Conn() *pgx.Conn        { return nil }

func (r *fakeRows) Scan(dest ...any) error {
	if r.idx == 0 || r.idx > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		if err := assign(d, row[i]); err != nil {
			return err
		}
	}
	return nil
}

// assign copies a fixture value into a Scan destination, supporting the
// destination shapes the package actually scans into.
func assign(dest, val any) error {
	switch dd := dest.(type) {
	case *int:
		switch v := val.(type) {
		case int:
			*dd = v
		case int64:
			*dd = int(v)
		}
	case *int64:
		switch v := val.(type) {
		case int:
			*dd = int64(v)
		case int64:
			*dd = v
		}
	case *float64:
		switch v := val.(type) {
		case float64:
			*dd = v
		case int:
			*dd = float64(v)
		}
	case *bool:
		if v, ok := val.(bool); ok {
			*dd = v
		}
	case *string:
		*dd = fmt.Sprint(val)
	case **string:
		if val == nil {
			*dd = nil
		} else {
			s := fmt.Sprint(val)
			*dd = &s
		}
	case *[]byte:
		switch v := val.(type) {
		case nil:
			*dd = nil
		case []byte:
			*dd = v
		case string:
			*dd = []byte(v)
		}
	case *time.Time:
		if v, ok := val.(time.Time); ok {
			*dd = v
		}
	case **time.Time:
		if val == nil {
			*dd = nil
		} else if v, ok := val.(time.Time); ok {
			t := v
			*dd = &t
		}
	case *uuid.UUID:
		switch v := val.(type) {
		case uuid.UUID:
			*dd = v
		case string:
			id, err := uuid.Parse(v)
			if err != nil {
				return err
			}
			*dd = id
		}
	case **uuid.UUID:
		switch v := val.(type) {
		case nil:
			*dd = nil
		case uuid.UUID:
			id := v
			*dd = &id
		case string:
			id, err := uuid.Parse(v)
			if err != nil {
				return err
			}
			*dd = &id
		}
	default:
		return fmt.Errorf("unsupported scan destination %T", dest)
	}
	return nil
}

type fakeRow struct{ rows *fakeRows }

func (r fakeRow) Scan(dest ...any) error {
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

type stub struct {
	match string
	rows  *fakeRows
}

type dbCall struct {
	sql  string
	args []any
}

type fakeDB struct {
	mu    sync.Mutex
	stubs []stub
	calls []dbCall
	// execTags overrides the command tag for Exec SQL containing the key.
	execTags map[string]pgconn.CommandTag
	// execErr fails Exec calls whose SQL contains the key.
	execErr map[string]error
	// queryErr fails Query/QueryRow calls whose SQL contains the key.
	queryErr map[string]error
	beginErr error
	commits  int
	rollbaks int
}

func (db *fakeDB) record(sql string, args []any) {
	db.mu.Lock()
	defer db.mu.Unlock()
	db.calls = append(db.calls, dbCall{sql: sql, args: args})
}

func (db *fakeDB) route(sql string, args []any) (*fakeRows, error) {
	db.record(sql, args)
	db.mu.Lock()
	defer db.mu.Unlock()
	for key, err := range db.queryErr {
		if strings.Contains(sql, key) {
			return nil, err
		}
	}
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			copyRows := *s.rows
			copyRows.idx = 0
			return &copyRows, nil
		}
	}
	return &fakeRows{}, nil
}

func (db *fakeDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := db.route(sql, args)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	rows, err := db.route(sql, args)
	if err != nil {
		return errRow{err}
	}
	return fakeRow{rows}
}

func (db *fakeDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.record(sql, args)
	db.mu.Lock()
	defer db.mu.Unlock()
	for key, err := range db.execErr {
		if strings.Contains(sql, key) {
			return pgconn.CommandTag{}, err
		}
	}
	for key, tag := range db.execTags {
		if strings.Contains(sql, key) {
			return tag, nil
		}
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (db *fakeDB) Begin(context.Context) (pgx.Tx, error) {
	if db.beginErr != nil {
		return nil, db.beginErr
	}
	return &fakeTx{db: db}, nil
}

// sqlCalls returns the recorded SQL containing the fragment.
func (db *fakeDB) sqlCalls(fragment string) []dbCall {
	db.mu.Lock()
	defer db.mu.Unlock()
	out := []dbCall{}
	for _, c := range db.calls {
		if strings.Contains(c.sql, fragment) {
			out = append(out, c)
		}
	}
	return out
}

type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }

// fakeTx implements pgx.Tx over the same routing table; a nested Begin
// models a savepoint by returning the same transaction.
type fakeTx struct{ db *fakeDB }

func (t *fakeTx) Begin(context.Context) (pgx.Tx, error) { return t, nil }
func (t *fakeTx) Commit(context.Context) error {
	t.db.mu.Lock()
	defer t.db.mu.Unlock()
	t.db.commits++
	return nil
}
func (t *fakeTx) Rollback(context.Context) error {
	t.db.mu.Lock()
	defer t.db.mu.Unlock()
	t.db.rollbaks++
	return nil
}
func (t *fakeTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("fakeTx: CopyFrom not supported")
}
func (t *fakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (t *fakeTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (t *fakeTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("fakeTx: Prepare not supported")
}
func (t *fakeTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return t.db.Exec(ctx, sql, args...)
}
func (t *fakeTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return t.db.Query(ctx, sql, args...)
}
func (t *fakeTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return t.db.QueryRow(ctx, sql, args...)
}
func (t *fakeTx) Conn() *pgx.Conn { return nil }

// cfgMap is a settings.Reader with full control of every value type.
type cfgMap struct {
	strs  map[string]string
	bools map[string]bool
	ints  map[string]int
}

func (c cfgMap) String(_ context.Context, key, fallback string) string {
	if v, ok := c.strs[key]; ok {
		return v
	}
	return fallback
}

func (c cfgMap) Bool(_ context.Context, key string, fallback bool) bool {
	if v, ok := c.bools[key]; ok {
		return v
	}
	return fallback
}

func (c cfgMap) Int(_ context.Context, key string, fallback int) int {
	if v, ok := c.ints[key]; ok {
		return v
	}
	return fallback
}
