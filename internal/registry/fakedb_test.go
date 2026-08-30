// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeRows implements pgx.Rows over literal column/row data.
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
func (r *fakeRows) Next() bool { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Values() ([]any, error) {
	return r.rows[r.idx-1], nil
}
func (r *fakeRows) RawValues() [][]byte { return nil }
func (r *fakeRows) Conn() *pgx.Conn     { return nil }

// Scan assigns row values into destinations by position.
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
			return fmt.Errorf("column %d: %w", i, err)
		}
	}
	return nil
}

func assign(dest, value any) error {
	switch d := dest.(type) {
	case *string:
		if value == nil {
			*d = ""
		} else {
			*d = fmt.Sprint(value)
		}
	case **string:
		if value == nil {
			*d = nil
		} else {
			s := fmt.Sprint(value)
			*d = &s
		}
	case *bool:
		b, _ := value.(bool)
		*d = b
	case *int:
		switch v := value.(type) {
		case int:
			*d = v
		case int64:
			*d = int(v)
		}
	case *int64:
		switch v := value.(type) {
		case int:
			*d = int64(v)
		case int64:
			*d = v
		}
	case *uuid.UUID:
		switch v := value.(type) {
		case uuid.UUID:
			*d = v
		case string:
			parsed, err := uuid.Parse(v)
			if err != nil {
				return err
			}
			*d = parsed
		}
	case **uuid.UUID:
		switch v := value.(type) {
		case uuid.UUID:
			*d = &v
		case string:
			parsed, err := uuid.Parse(v)
			if err != nil {
				return err
			}
			*d = &parsed
		case nil:
			*d = nil
		}
	case *[]byte:
		switch v := value.(type) {
		case []byte:
			*d = v
		case string:
			*d = []byte(v)
		case nil:
			*d = nil
		}
	case *time.Time:
		if t, ok := value.(time.Time); ok {
			*d = t
		}
	case **time.Time:
		if t, ok := value.(time.Time); ok {
			*d = &t
		} else {
			*d = nil
		}
	case *any:
		*d = value
	default:
		return fmt.Errorf("unsupported scan destination %T", dest)
	}
	return nil
}

// fakeRow adapts fakeRows to the single-row surface.
type fakeRow struct{ rows *fakeRows }

func (r fakeRow) Scan(dest ...any) error {
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

// stub answers queries whose SQL contains the match fragment.
type stub struct {
	match string
	rows  *fakeRows
	err   error
}

// fakeDB routes queries to stubs by SQL substring, recording every statement.
type fakeDB struct {
	stubs []stub
	log   []string
}

func (db *fakeDB) route(sql string) (*fakeRows, error) {
	db.log = append(db.log, sql)
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			if s.err != nil {
				return nil, s.err
			}
			// Fresh cursor per query.
			copyRows := *s.rows
			copyRows.idx = 0
			return &copyRows, nil
		}
	}
	return &fakeRows{}, nil
}

func (db *fakeDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	return db.route(sql)
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	rows, err := db.route(sql)
	if err != nil {
		return errRow{err}
	}
	return fakeRow{rows}
}

func (db *fakeDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.log = append(db.log, sql)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (db *fakeDB) Begin(_ context.Context) (pgx.Tx, error) {
	return nil, errors.New("fakeDB: transactions not supported")
}

type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }
