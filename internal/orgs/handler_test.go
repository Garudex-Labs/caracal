// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
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
		if err := assignVal(d, row[i]); err != nil {
			return fmt.Errorf("column %d: %w", i, err)
		}
	}
	return nil
}

func assignVal(dest, value any) error {
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
	case *int:
		switch v := value.(type) {
		case int:
			*d = v
		case int64:
			*d = int(v)
		}
	case *bool:
		b, _ := value.(bool)
		*d = b
	case *uuid.UUID:
		u, _ := value.(uuid.UUID)
		*d = u
	case **uuid.UUID:
		switch v := value.(type) {
		case nil:
			*d = nil
		case uuid.UUID:
			u := v
			*d = &u
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
	mu    sync.Mutex
	stubs []stub
	log   []string
}

func (db *fakeDB) route(sql string) *fakeRows {
	db.mu.Lock()
	db.log = append(db.log, sql)
	db.mu.Unlock()
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			copyRows := *s.rows
			copyRows.idx = 0
			return &copyRows
		}
	}
	return &fakeRows{}
}

func (db *fakeDB) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	return db.route(sql), nil
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	return fakeRow{db.route(sql)}
}

func (db *fakeDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.mu.Lock()
	db.log = append(db.log, sql)
	db.mu.Unlock()
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (db *fakeDB) Begin(_ context.Context) (pgx.Tx, error) {
	return nil, errors.New("fakeDB: transactions not supported")
}

type fakeSetting struct{}

func (fakeSetting) String(_ context.Context, _, fallback string) string { return fallback }

// ── handler tests ───────────────────────────────────────────────────────────

var (
	orgID    = uuid.MustParse("11111111-1111-1111-1111-111111111111")
	callerID = uuid.MustParse("22222222-2222-2222-2222-222222222222")
	orgTime  = time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
)

// orgRowValues matches the o.id..suspended_at..m.role scan order.
func orgRowValues(slug, name, role string) []any {
	return []any{orgID, slug, name, nil, orgTime, nil, role}
}

func serveOrgs(t *testing.T, db *fakeDB, target string, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}, Settings: fakeSetting{}}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{UserID: callerID, Role: "user"})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims)
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestMyOrgsListsMemberships(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		// MyOrgs selects six columns (no suspended_at, unlike ResolveOrg).
		{match: "m.user_id = $1", rows: &fakeRows{rows: [][]any{
			{orgID, "acme", "Acme", nil, orgTime, "owner"},
		}}},
	}}
	rec := serveOrgs(t, db, "/api/v1/orgs", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out) != 1 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if out[0]["slug"] != "acme" || out[0]["role"] != "owner" {
		t.Errorf("org wire: %v", out[0])
	}
}

func TestOrgDetailForMember(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "WHERE o.slug = $1", rows: &fakeRows{rows: [][]any{
			orgRowValues("acme", "Acme", "member"),
		}}},
		{match: "FROM organization_memberships WHERE organization_id", rows: &fakeRows{rows: [][]any{{5}}}},
		{match: "FROM projects WHERE organization_id", rows: &fakeRows{rows: [][]any{{2}}}},
	}}
	rec := serveOrgs(t, db, "/api/v1/orgs/acme", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["member_count"] != float64(5) || out["project_count"] != float64(2) {
		t.Errorf("counts: %v", out)
	}
}

func TestOrgResolutionFailsClosed(t *testing.T) {
	// Non-membership answers exactly like a missing organization.
	rec := serveOrgs(t, &fakeDB{}, "/api/v1/orgs/acme", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-member: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Organization not found") {
		t.Errorf("denial detail: %s", rec.Body.String())
	}
}

func TestMalformedOrgSlugNeverTouchesStorage(t *testing.T) {
	db := &fakeDB{}
	rec := serveOrgs(t, db, "/api/v1/orgs/Not%20A%20Slug!", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("malformed slug: status = %d", rec.Code)
	}
	if len(db.log) != 0 {
		t.Errorf("malformed slug reached the database: %v", db.log)
	}
}

func TestOrgScopeHeaderMustAgreeWithPath(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "WHERE o.slug = $1", rows: &fakeRows{rows: [][]any{
			orgRowValues("acme", "Acme", "member"),
		}}},
		{match: "FROM organization_memberships WHERE organization_id", rows: &fakeRows{rows: [][]any{{1}}}},
		{match: "FROM projects WHERE organization_id", rows: &fakeRows{rows: [][]any{{0}}}},
	}}
	rec := serveOrgs(t, db, "/api/v1/orgs/acme", map[string]string{"X-Caracal-Org": "other"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("scope mismatch: status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "scope mismatch") {
		t.Errorf("409 detail: %s", rec.Body.String())
	}

	// The same header agreeing with the path resolves normally.
	rec = serveOrgs(t, db, "/api/v1/orgs/acme", map[string]string{"X-Caracal-Org": "acme"})
	if rec.Code != http.StatusOK {
		t.Errorf("agreeing header: status = %d: %s", rec.Code, rec.Body.String())
	}
}
