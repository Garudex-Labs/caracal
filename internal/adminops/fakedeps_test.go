// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// fakeRows implements pgx.Rows over literal column/row data.
type fakeRows struct {
	rows [][]any
	idx  int
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Next() bool                                   { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Values() ([]any, error)                       { return r.rows[r.idx-1], nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }

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
			*d = uuid.MustParse(v)
		}
	case *time.Time:
		t, _ := value.(time.Time)
		*d = t
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

// stub answers queries whose SQL contains match; a non-empty argMatch also
// requires some bound argument to carry that substring, so the fake can
// distinguish key-parameterized lookups that share one SQL text.
type stub struct {
	match    string
	argMatch string
	rows     [][]any
}

// execStub answers Exec statements the same way, with a canned row count.
type execStub struct {
	match    string
	argMatch string
	affected int64
	err      error
}

func stubMatches(sql string, args []any, match, argMatch string) bool {
	if !strings.Contains(sql, match) {
		return false
	}
	if argMatch == "" {
		return true
	}
	for _, a := range args {
		if strings.Contains(fmt.Sprint(a), argMatch) {
			return true
		}
	}
	return false
}

// fakeDB routes statements to stubs by SQL substring, recording every
// statement and its arguments for storage-contact assertions. It is
// mutex-guarded because status probes query concurrently.
type fakeDB struct {
	mu    sync.Mutex
	stubs []stub
	execs []execStub
	log   []string
	args  [][]any
}

func (db *fakeDB) record(sql string, args []any) {
	db.mu.Lock()
	db.log = append(db.log, sql)
	db.args = append(db.args, args)
	db.mu.Unlock()
}

func (db *fakeDB) route(sql string, args []any) *fakeRows {
	db.record(sql, args)
	for _, s := range db.stubs {
		if stubMatches(sql, args, s.match, s.argMatch) {
			return &fakeRows{rows: s.rows}
		}
	}
	return &fakeRows{}
}

func (db *fakeDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	return db.route(sql, args), nil
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	return fakeRow{db.route(sql, args)}
}

func (db *fakeDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.record(sql, args)
	for _, e := range db.execs {
		if stubMatches(sql, args, e.match, e.argMatch) {
			if e.err != nil {
				return pgconn.CommandTag{}, e.err
			}
			return pgconn.NewCommandTag(fmt.Sprintf("STUB %d", e.affected)), nil
		}
	}
	return pgconn.NewCommandTag("STUB 1"), nil
}

// statement finds the first recorded statement containing match.
func (db *fakeDB) statement(match string) (string, []any, bool) {
	db.mu.Lock()
	defer db.mu.Unlock()
	for i, sql := range db.log {
		if strings.Contains(sql, match) {
			return sql, db.args[i], true
		}
	}
	return "", nil, false
}

func (db *fakeDB) countStatements(match string) int {
	db.mu.Lock()
	defer db.mu.Unlock()
	n := 0
	for _, sql := range db.log {
		if strings.Contains(sql, match) {
			n++
		}
	}
	return n
}

// chBackend fakes the analytics store over its HTTP interface.
type chBackend struct {
	mu      sync.Mutex
	rows    []map[string]any
	status  int
	bodies  []string
	queries []url.Values
}

func (b *chBackend) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	b.mu.Lock()
	b.bodies = append(b.bodies, string(body))
	b.queries = append(b.queries, r.URL.Query())
	status := b.status
	rows := b.rows
	b.mu.Unlock()
	if status != 0 && status != http.StatusOK {
		http.Error(w, "boom", status)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
}

func (b *chBackend) requestCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.bodies)
}

func (b *chBackend) body(i int) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.bodies[i]
}

func (b *chBackend) lastQuery() url.Values {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.queries[len(b.queries)-1]
}

func newCHClient(t *testing.T, backend *chBackend) *clickhouse.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(backend.handler))
	t.Cleanup(srv.Close)
	client, err := clickhouse.New(srv.URL, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}

var testAdminID = uuid.MustParse("22222222-2222-2222-2222-222222222222")

// asAdmin attaches operator claims to the request context.
func asAdmin(r *http.Request) *http.Request {
	return r.WithContext(httpapi.ContextWithClaims(r.Context(),
		auth.Claims{UserID: testAdminID, Role: "operator"}))
}

// callerStub satisfies the caller() row lookup for the test admin.
func callerStub() stub {
	return stub{match: "FROM users WHERE id",
		rows: [][]any{{"admin@example.com", "operator"}}}
}
