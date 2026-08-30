// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/registry"
)

// richRows is a scan-capable fake that, unlike the handler_test fakeRows,
// assigns bool, uuid, and time destinations the lock and review paths need.
type richRows struct {
	cols []string
	rows [][]any
	idx  int
}

func (r *richRows) Close()                        {}
func (r *richRows) Err() error                    { return nil }
func (r *richRows) CommandTag() pgconn.CommandTag { return pgconn.CommandTag{} }
func (r *richRows) RawValues() [][]byte           { return nil }
func (r *richRows) Conn() *pgx.Conn               { return nil }
func (r *richRows) Next() bool                    { r.idx++; return r.idx <= len(r.rows) }
func (r *richRows) Values() ([]any, error)        { return r.rows[r.idx-1], nil }

func (r *richRows) FieldDescriptions() []pgconn.FieldDescription {
	out := make([]pgconn.FieldDescription, len(r.cols))
	for i, c := range r.cols {
		out[i] = pgconn.FieldDescription{Name: c}
	}
	return out
}

func (r *richRows) Scan(dest ...any) error {
	if r.idx == 0 || r.idx > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		if err := assignRich(d, row[i]); err != nil {
			return err
		}
	}
	return nil
}

func assignRich(dest, val any) error {
	switch dd := dest.(type) {
	case *bool:
		b, _ := val.(bool)
		*dd = b
	case *string:
		*dd = fmt.Sprint(val)
	case **string:
		if val == nil {
			*dd = nil
		} else {
			s := fmt.Sprint(val)
			*dd = &s
		}
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
	case *uuid.UUID:
		if id, ok := val.(uuid.UUID); ok {
			*dd = id
		}
	case **uuid.UUID:
		if val == nil {
			*dd = nil
		} else if id, ok := val.(uuid.UUID); ok {
			*dd = &id
		}
	case *time.Time:
		if tv, ok := val.(time.Time); ok {
			*dd = tv
		}
	case **time.Time:
		if val == nil {
			*dd = nil
		} else if tv, ok := val.(time.Time); ok {
			*dd = &tv
		}
	default:
		return fmt.Errorf("richRows: unsupported scan destination %T", dest)
	}
	return nil
}

type richRow struct{ rows *richRows }

func (r richRow) Scan(dest ...any) error {
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

type richStub struct {
	match string
	rows  *richRows
}

// richDB routes SQL to the first matching stub, like the handler_test fakeDB,
// but returns rich rows and can be told to fail Begin or not.
type richDB struct {
	stubs    []richStub
	log      []string
	beginOK  bool
	execRows int64
}

func (db *richDB) route(sql string) *richRows {
	db.log = append(db.log, sql)
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			cp := *s.rows
			cp.idx = 0
			return &cp
		}
	}
	return &richRows{}
}

func (db *richDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	return db.route(sql), nil
}

func (db *richDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	return richRow{db.route(sql)}
}

func (db *richDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.log = append(db.log, sql)
	n := db.execRows
	if n == 0 {
		n = 1
	}
	return pgconn.NewCommandTag(fmt.Sprintf("UPDATE %d", n)), nil
}

func (db *richDB) Begin(ctx context.Context) (pgx.Tx, error) {
	if !db.beginOK {
		return nil, errors.New("richDB: transactions not supported")
	}
	return &richTx{db: db}, nil
}

// richTx satisfies pgx.Tx by delegating the read/write surface to its richDB;
// the rest is inert because the covered helpers never reach it.
type richTx struct{ db *richDB }

func (tx *richTx) Begin(context.Context) (pgx.Tx, error) { return tx, nil }
func (tx *richTx) Commit(context.Context) error          { return nil }
func (tx *richTx) Rollback(context.Context) error        { return nil }
func (tx *richTx) Conn() *pgx.Conn                       { return nil }

func (tx *richTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (tx *richTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (tx *richTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (tx *richTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (tx *richTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return tx.db.Exec(ctx, sql, args...)
}
func (tx *richTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return tx.db.Query(ctx, sql, args...)
}
func (tx *richTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return tx.db.QueryRow(ctx, sql, args...)
}

// serveAgentsDB is serveAgents over any PGQuerier, so tests can drive handlers
// with the rich fake and a registry stub for the draft-creation route.
func serveAgentsDB(t *testing.T, db registry.PGQuerier, method, target, role, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}, Registry: fakeRegistryStore{}}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{
				UserID: uuid.MustParse(viewerID),
				Role:   role,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims, withClaims)
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}
