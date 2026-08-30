// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ── package-local pgx fake ──────────────────────────────────────────────────

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
		if err := assignInbox(d, row[i]); err != nil {
			return fmt.Errorf("column %d: %w", i, err)
		}
	}
	return nil
}

func assignInbox(dest, value any) error {
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
	case *time.Time:
		t, _ := value.(time.Time)
		*d = t
	case **time.Time:
		switch v := value.(type) {
		case nil:
			*d = nil
		case time.Time:
			t := v
			*d = &t
		}
	case *map[string]any:
		m, _ := value.(map[string]any)
		*d = m
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
	case *[]byte:
		switch v := value.(type) {
		case nil:
			*d = nil
		case []byte:
			*d = v
		case string:
			*d = []byte(v)
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

type fakeDB struct {
	stubs []stub
	log   []string
	args  [][]any
}

func (db *fakeDB) route(sql string, args []any) *fakeRows {
	db.log = append(db.log, sql)
	db.args = append(db.args, args)
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			copyRows := *s.rows
			copyRows.idx = 0
			return &copyRows
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

func (db *fakeDB) Begin(_ context.Context) (pgx.Tx, error) {
	return nil, errors.New("fakeDB: transactions not supported")
}

// ── fixtures ────────────────────────────────────────────────────────────────

var (
	inboxUser = uuid.MustParse("22222222-2222-2222-2222-222222222222")
	inboxTime = time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
)

// itemRowValues matches the itemColumns scan order in scanItem.
func itemRowValues(id, kind string) []any {
	return []any{
		id, kind, "open", nil, true, "You were invited", nil,
		"agent", nil, nil, nil,
		nil, nil, nil, nil,
		map[string]any{"k": "v"}, inboxTime, nil,
	}
}

// ── tests ───────────────────────────────────────────────────────────────────

func TestListPagesWithStableTiebreak(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT count(*)", rows: &fakeRows{rows: [][]any{{2}}}},
		{match: "ORDER BY", rows: &fakeRows{rows: [][]any{
			itemRowValues("i2", "ownership_transfer"),
			itemRowValues("i1", "ownership_transfer"),
		}}},
	}}
	store := &Store{DB: db}
	items, total, err := store.List(context.Background(), inboxUser, "user", Filters{}, "", 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(items) != 2 || items[0].ID != "i2" {
		t.Fatalf("page: total=%d items=%d", total, len(items))
	}
	if items[0].Payload["k"] != "v" {
		t.Errorf("payload lost: %v", items[0].Payload)
	}

	// Both directions carry the id tiebreak alongside created_at.
	pageSQL := db.log[len(db.log)-1]
	if !strings.Contains(pageSQL, "i.created_at DESC, i.id DESC") {
		t.Errorf("default order missing stable tiebreak:\n%s", pageSQL)
	}
	if _, _, err := store.List(context.Background(), inboxUser, "user", Filters{}, "oldest", 1, 20); err != nil {
		t.Fatal(err)
	}
	pageSQL = db.log[len(db.log)-1]
	if !strings.Contains(pageSQL, "i.created_at ASC, i.id ASC") {
		t.Errorf("oldest order missing stable tiebreak:\n%s", pageSQL)
	}
}

func TestListFiltersBindValuesNotText(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT count(*)", rows: &fakeRows{rows: [][]any{{0}}}},
	}}
	action := true
	unread := true
	filters := Filters{
		State: "open", Kind: "ownership_transfer", SubjectType: "agent",
		ActionRequired: &action, Unread: &unread,
		Q: "50%_off' OR '1'='1",
	}
	if _, _, err := (&Store{DB: db}).List(context.Background(), inboxUser, "user", filters, "", 1, 20); err != nil {
		t.Fatal(err)
	}
	sql := db.log[0]
	for _, want := range []string{"i.state = $", "i.kind = $", "i.subject_type = $", "i.action_required = $", "i.read_at IS NULL"} {
		if !strings.Contains(sql, want) {
			t.Errorf("filter fragment %q missing:\n%s", want, sql)
		}
	}
	// The raw search text must never appear in the SQL; it travels as a
	// bound, LIKE-escaped argument.
	if strings.Contains(sql, "50%_off") {
		t.Errorf("query text interpolated into SQL:\n%s", sql)
	}
	foundEscaped := false
	for _, arg := range db.args[0] {
		if s, ok := arg.(string); ok && strings.Contains(s, `50\%\_off`) {
			foundEscaped = true
		}
	}
	if !foundEscaped {
		t.Errorf("LIKE wildcards not escaped in bound args: %v", db.args[0])
	}
}

func TestVisibilityScopeAdminsSkipRecheck(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT count(*)", rows: &fakeRows{rows: [][]any{{0}}}},
	}}
	store := &Store{DB: db}
	if _, _, err := store.List(context.Background(), inboxUser, "user", Filters{}, "", 1, 20); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(db.log[0], "project_memberships") {
		t.Errorf("plain user query skips the visibility recheck:\n%s", db.log[0])
	}

	adminDB := &fakeDB{stubs: db.stubs}
	if _, _, err := (&Store{DB: adminDB}).List(context.Background(), inboxUser, "operator", Filters{}, "", 1, 20); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(adminDB.log[0], "project_memberships") {
		t.Errorf("operator query wrongly rechecks visibility:\n%s", adminDB.log[0])
	}
}

func TestCountBadgesAndFacets(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "i.read_at IS NULL", rows: &fakeRows{rows: [][]any{{3}}}},
		{match: "action_required", rows: &fakeRows{rows: [][]any{{1}}}},
		{match: "GROUP BY", rows: &fakeRows{rows: [][]any{{"ownership_transfer", 2}, {"review", 1}}}},
	}}
	out, err := (&Store{DB: db}).Count(context.Background(), inboxUser, "user", true, "open")
	if err != nil {
		t.Fatal(err)
	}
	if out.Unread != 3 || out.Action != 1 {
		t.Errorf("badges: %+v", out)
	}
	if out.ByKind["ownership_transfer"] != 2 && out.ByState["ownership_transfer"] != 2 {
		t.Errorf("facets not populated: %+v", out)
	}
}

func TestLoadOwnMissingItem(t *testing.T) {
	_, err := (&Store{DB: &fakeDB{}}).LoadOwn(context.Background(), uuid.New(), inboxUser, "user")
	if err == nil {
		t.Fatal("missing item must error")
	}
}

func TestEscapeLike(t *testing.T) {
	if got := escapeLike(`100%_a\b`); got != `100\%\_a\\b` {
		t.Errorf("escapeLike = %q", got)
	}
}
