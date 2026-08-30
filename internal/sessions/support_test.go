// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"
)

// dirRows plays back positional (uuid, name) rows.
type dirRows struct {
	rows [][]any
	idx  int
}

func (r *dirRows) Close()                                       {}
func (r *dirRows) Err() error                                   { return nil }
func (r *dirRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *dirRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *dirRows) Next() bool                                   { r.idx++; return r.idx <= len(r.rows) }
func (r *dirRows) Values() ([]any, error)                       { return r.rows[r.idx-1], nil }
func (r *dirRows) RawValues() [][]byte                          { return nil }
func (r *dirRows) Conn() *pgx.Conn                              { return nil }

func (r *dirRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	for i, d := range dest {
		switch v := d.(type) {
		case *uuid.UUID:
			*v = row[i].(uuid.UUID)
		case *string:
			*v = row[i].(string)
		}
	}
	return nil
}

// dirDB records the statements and arguments the directory issues.
type dirDB struct {
	rows     *dirRows
	queryErr error
	rowName  string
	rowErr   error
	sqls     []string
	args     [][]any
}

func (d *dirDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	d.sqls = append(d.sqls, sql)
	d.args = append(d.args, args)
	if d.queryErr != nil {
		return nil, d.queryErr
	}
	fresh := *d.rows
	fresh.idx = 0
	return &fresh, nil
}

func (d *dirDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	d.sqls = append(d.sqls, sql)
	d.args = append(d.args, args)
	return nameRow{d.rowName, d.rowErr}
}

type nameRow struct {
	name string
	err  error
}

func (r nameRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*string)) = r.name
	return nil
}

func TestDirectoryUserNamesSkipsUnparseableIDs(t *testing.T) {
	idA := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	db := &dirDB{rows: &dirRows{rows: [][]any{{idA, "Richard"}}}}
	dir := &Directory{DB: db}

	names := dir.UserNames(context.Background(), []string{idA.String(), "not-a-uuid"})
	if names[idA.String()] != "Richard" || len(names) != 1 {
		t.Fatalf("names = %v", names)
	}
	if len(db.sqls) != 1 || !strings.Contains(db.sqls[0], "FROM users") {
		t.Fatalf("sqls = %v", db.sqls)
	}
	parsed, ok := db.args[0][0].([]uuid.UUID)
	if !ok || len(parsed) != 1 || parsed[0] != idA {
		t.Fatalf("bound ids = %v", db.args[0])
	}
}

func TestDirectoryNamesWithoutValidIDsNeverQueries(t *testing.T) {
	db := &dirDB{rows: &dirRows{}}
	dir := &Directory{DB: db}
	names := dir.UserNames(context.Background(), []string{"garbage", ""})
	if len(names) != 0 {
		t.Fatalf("names = %v", names)
	}
	if len(db.sqls) != 0 {
		t.Fatalf("no valid ids must not reach the database: %v", db.sqls)
	}
}

func TestDirectoryNamesQueryFailureDegradesToEmpty(t *testing.T) {
	db := &dirDB{queryErr: errors.New("pg down")}
	dir := &Directory{DB: db}
	names := dir.AgentNames(context.Background(), []string{uuid.NewString()})
	if names == nil || len(names) != 0 {
		t.Fatalf("names = %v, want empty map", names)
	}
	if !strings.Contains(db.sqls[0], "FROM agents") {
		t.Fatalf("sqls = %v", db.sqls)
	}
}

func TestDirectoryUserName(t *testing.T) {
	db := &dirDB{rowName: "Richard Hendricks"}
	dir := &Directory{DB: db}
	if got := dir.UserName(context.Background(), uuid.New()); got != "Richard Hendricks" {
		t.Fatalf("name = %q", got)
	}

	db.rowErr = pgx.ErrNoRows
	if got := dir.UserName(context.Background(), uuid.New()); got != "" {
		t.Fatalf("missing user should resolve to empty name, got %q", got)
	}
}

func TestResolveUserFilterDeduplicatesUUIDLiteral(t *testing.T) {
	id := uuid.MustParse("33333333-3333-3333-3333-333333333333")
	db := &dirDB{rows: &dirRows{rows: [][]any{{id}}}}
	dir := &Directory{DB: db}

	ids := dir.ResolveUserFilter(context.Background(), id.String())
	if len(ids) != 1 || ids[0] != id.String() {
		t.Fatalf("ids = %v, want the uuid exactly once", ids)
	}
}

func TestResolveUserFilterShortQueryNeverQueries(t *testing.T) {
	db := &dirDB{rows: &dirRows{}}
	dir := &Directory{DB: db}
	if ids := dir.ResolveUserFilter(context.Background(), "@x"); len(ids) != 0 {
		t.Fatalf("ids = %v", ids)
	}
	if len(db.sqls) != 0 {
		t.Fatalf("short queries must not reach the database: %v", db.sqls)
	}
}

func TestResolveUserFilterNormalizesAndEscapesInput(t *testing.T) {
	idA := uuid.MustParse("44444444-4444-4444-4444-444444444444")
	idB := uuid.MustParse("55555555-5555-5555-5555-555555555555")
	db := &dirDB{rows: &dirRows{rows: [][]any{{idA}, {idB}}}}
	dir := &Directory{DB: db}

	ids := dir.ResolveUserFilter(context.Background(), "  MI%RA   Chen_ ")
	if len(ids) != 2 || ids[0] != idA.String() || ids[1] != idB.String() {
		t.Fatalf("ids = %v", ids)
	}
	args := db.args[0]
	if args[0] != "mi%ra chen_" {
		t.Fatalf("normalized query = %q", args[0])
	}
	if args[1] != `mi\%ra chen\_%` {
		t.Fatalf("prefix pattern = %q", args[1])
	}
	if args[2] != `%mi\%ra chen\_%` {
		t.Fatalf("substring pattern = %q", args[2])
	}
}

func TestResolveUserFilterQueryFailureKeepsUUIDMatch(t *testing.T) {
	id := uuid.MustParse("66666666-6666-6666-6666-666666666666")
	db := &dirDB{queryErr: errors.New("pg down")}
	dir := &Directory{DB: db}
	ids := dir.ResolveUserFilter(context.Background(), id.String())
	if len(ids) != 1 || ids[0] != id.String() {
		t.Fatalf("ids = %v, want the literal uuid to survive", ids)
	}
}

func TestEscapeLikeOrdersBackslashFirst(t *testing.T) {
	cases := []struct{ in, want string }{
		{`50%`, `50\%`},
		{`a_b`, `a\_b`},
		{`c:\dir`, `c:\\dir`},
		{`\%`, `\\\%`},
	}
	for _, tc := range cases {
		if got := escapeLike(tc.in); got != tc.want {
			t.Errorf("escapeLike(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// setRecorder captures the single redis call the binder makes.
type setRecorder struct {
	key   string
	value any
	ttl   time.Duration
	err   error
}

func (s *setRecorder) Set(_ context.Context, key string, value any, ttl time.Duration) *redis.StatusCmd {
	s.key, s.value, s.ttl = key, value, ttl
	return redis.NewStatusResult("OK", s.err)
}

func TestRedisBinderBindsForOneDay(t *testing.T) {
	rec := &setRecorder{}
	binder := RedisBinder{Client: rec}
	if err := binder.BindAgent(context.Background(), "s-1", "deploy-bot"); err != nil {
		t.Fatal(err)
	}
	if rec.key != "session_agent:s-1" || rec.value != "deploy-bot" || rec.ttl != 24*time.Hour {
		t.Fatalf("recorded set = %q %v %v", rec.key, rec.value, rec.ttl)
	}

	rec.err = errors.New("redis down")
	if err := binder.BindAgent(context.Background(), "s-1", "deploy-bot"); err == nil {
		t.Fatal("redis failure must surface to the caller")
	}
}
