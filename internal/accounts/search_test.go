// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package accounts

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// ── minimal pgx fake for the search surface ─────────────────────────────────

type fakeRows struct {
	rows [][]any
	idx  int
}

func (r *fakeRows) Close()     {}
func (r *fakeRows) Err() error { return nil }
func (r *fakeRows) Next() bool { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Scan(dest ...any) error {
	if r.idx == 0 || r.idx > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		switch dd := d.(type) {
		case *string:
			if row[i] == nil {
				*dd = ""
			} else {
				*dd = fmt.Sprint(row[i])
			}
		case **string:
			if row[i] == nil {
				*dd = nil
			} else {
				s := fmt.Sprint(row[i])
				*dd = &s
			}
		default:
			return fmt.Errorf("unsupported scan destination %T", d)
		}
	}
	return nil
}

type searchDB struct {
	rows *fakeRows
	log  []string
}

func (db *searchDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	db.log = append(db.log, sql)
	copyRows := *db.rows
	copyRows.idx = 0
	return &searchRowsAdapter{&copyRows}, nil
}

func (db *searchDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	db.log = append(db.log, sql)
	return errRow{}
}

func (db *searchDB) Begin(_ context.Context) (pgx.Tx, error) {
	return nil, pgx.ErrNoRows
}

func (db *searchDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.log = append(db.log, sql)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

// searchRowsAdapter fills the unused pgx.Rows surface.
type searchRowsAdapter struct{ *fakeRows }

func (searchRowsAdapter) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (searchRowsAdapter) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (searchRowsAdapter) Values() ([]any, error)                       { return nil, nil }
func (searchRowsAdapter) RawValues() [][]byte                          { return nil }
func (searchRowsAdapter) Conn() *pgx.Conn                              { return nil }

type errRow struct{}

func (errRow) Scan(...any) error { return pgx.ErrNoRows }

// ── handler wiring ──────────────────────────────────────────────────────────

func serveSearch(t *testing.T, db *searchDB, target string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}}
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: uuid.MustParse("22222222-2222-2222-2222-222222222222"), Role: "user",
	}))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestSearchUsersValidatesQuery(t *testing.T) {
	db := &searchDB{rows: &fakeRows{}}
	cases := []struct {
		target   string
		wantType string
	}{
		{"/api/v1/users/search", "missing"},
		{"/api/v1/users/search?q=a", "string_too_short"},
		{"/api/v1/users/search?q=" + strings.Repeat("x", 256), "string_too_long"},
		{"/api/v1/users/search?q=raw&limit=abc", "int_parsing"},
	}
	for _, tc := range cases {
		rec := serveSearch(t, db, tc.target)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d", tc.target, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), tc.wantType) {
			t.Errorf("%s: error type %q missing: %s", tc.target, tc.wantType, rec.Body.String())
		}
	}
	if len(db.log) != 0 {
		t.Errorf("invalid queries reached the database: %v", db.log)
	}
}

func TestSearchUsersMarksDeactivatedAccounts(t *testing.T) {
	deactivated := "deactivated"
	_ = deactivated
	db := &searchDB{rows: &fakeRows{rows: [][]any{
		// id, email, username, name, avatar_url, role, auth_provider
		{"u1", "raw@x.com", "rawx18", "Raw", nil, "user", nil},
		{"u2", "gone@x.com", nil, "Gone", nil, "user", "deactivated"},
	}}}
	rec := serveSearch(t, db, "/api/v1/users/search?q=ra")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out) != 2 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if out[0]["is_active"] != true || out[1]["is_active"] != false {
		t.Errorf("activity flags: %v", out)
	}
	if out[1]["username"] != nil {
		t.Errorf("null username must stay null: %v", out[1])
	}
}

func TestSearchUsersShortNormalizedQuerySkipsStorage(t *testing.T) {
	db := &searchDB{rows: &fakeRows{}}
	// "@a" passes the raw length check but normalizes to one character.
	rec := serveSearch(t, db, "/api/v1/users/search?q=@a")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("short normalized query: %d %s", rec.Code, rec.Body.String())
	}
	if len(db.log) != 0 {
		t.Errorf("short query reached the database: %v", db.log)
	}
}
