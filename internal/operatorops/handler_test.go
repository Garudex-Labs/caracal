// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package operatorops

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/orgs"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

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
		switch p := d.(type) {
		case *string:
			p2, _ := row[i].(string)
			*p = p2
		case **string:
			if row[i] == nil {
				*p = nil
			} else {
				s, _ := row[i].(string)
				*p = &s
			}
		case *int64:
			p2, _ := row[i].(int64)
			*p = p2
		case *time.Time:
			p2, _ := row[i].(time.Time)
			*p = p2
		case **time.Time:
			if row[i] == nil {
				*p = nil
			} else {
				ts, _ := row[i].(time.Time)
				*p = &ts
			}
		}
	}
	return nil
}

// stub answers every query whose SQL contains match.
type stub struct {
	match string
	rows  [][]any
	err   error
}

// fakeDB routes queries to the first stub whose match substring appears in
// the SQL, recording SQL and args for assertions.
type fakeDB struct {
	stubs   []stub
	sql     []string
	args    [][]any
	execSQL []string
	execTag pgconn.CommandTag
	execErr error
}

func (db *fakeDB) find(sql string) *stub {
	for i := range db.stubs {
		if strings.Contains(sql, db.stubs[i].match) {
			return &db.stubs[i]
		}
	}
	return nil
}

func (db *fakeDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	db.sql = append(db.sql, sql)
	db.args = append(db.args, args)
	s := db.find(sql)
	if s == nil {
		return &fakeRows{}, nil
	}
	if s.err != nil {
		return nil, s.err
	}
	return &fakeRows{rows: s.rows}, nil
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.sql = append(db.sql, sql)
	db.args = append(db.args, args)
	s := db.find(sql)
	if s == nil || s.err != nil || len(s.rows) == 0 {
		return &fakeRows{}
	}
	r := &fakeRows{rows: s.rows}
	r.Next()
	return r
}

func (db *fakeDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.execSQL = append(db.execSQL, sql)
	return db.execTag, db.execErr
}

type fakeCH struct {
	rows []map[string]any
	err  error
	sql  []string
}

func (ch *fakeCH) QueryJSON(_ context.Context, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
	ch.sql = append(ch.sql, sql)
	return ch.rows, ch.err
}

type fakeLifecycle struct {
	err error
	got *orgs.Org
}

func (f *fakeLifecycle) DeleteSuspendedOrg(_ context.Context, _ orgs.TxBeginner, org *orgs.Org) error {
	f.got = org
	return f.err
}

func serve(t *testing.T, h *Handler, role, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	floor := func(next http.Handler) http.Handler {
		return httpapi.RequireRole("operator", next)
	}
	h.Register(mux, floor)
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	if role != "" {
		req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{Role: role}))
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// countersStub answers the overview totals query:
// orgs, suspended, projects, users, operators, reviewers, agents.
func countersStub(vals ...int64) stub {
	row := make([]any, len(vals))
	for i, v := range vals {
		row[i] = v
	}
	return stub{match: "FROM users WHERE role", rows: [][]any{row}}
}

const (
	orgA = "11111111-1111-1111-1111-111111111111"
	orgB = "22222222-2222-2222-2222-222222222222"
)

func activityStubs() (*fakeCH, []stub) {
	ch := &fakeCH{rows: []map[string]any{
		{"project_id": "p1", "sessions": "120", "events": "9000"},
		{"project_id": "p2", "sessions": "30", "events": "1000"},
	}}
	mapping := stub{match: "FROM projects p WHERE p.id::text", rows: [][]any{
		{"p1", orgA},
		{"p2", orgB},
	}}
	return ch, []stub{mapping}
}

func TestOverviewTotalsGrowthAndActivity(t *testing.T) {
	ch, extra := activityStubs()
	now := time.Now().UTC()
	monday := now.AddDate(0, 0, -((int(now.Weekday()) + 6) % 7)).Format("2006-01-02")
	db := &fakeDB{stubs: append([]stub{
		countersStub(3, 1, 7, 40, 2, 4, 11),
		{match: "date_trunc('week'", rows: [][]any{
			{"users", monday, int64(5)},
			{"organizations", monday, int64(2)},
		}},
		{match: "SELECT o.id::text, o.slug, o.name FROM organizations o", rows: [][]any{
			{orgA, "acme", "Acme Corp"},
			{orgB, "beta", "Beta LLC"},
		}},
	}, extra...)}
	rec := serve(t, &Handler{DB: db, CH: ch}, "operator", http.MethodGet, "/api/v1/operator/overview", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Totals struct {
			Organizations          float64 `json:"organizations"`
			OrganizationsSuspended float64 `json:"organizations_suspended"`
			Projects               float64 `json:"projects"`
			Agents                 float64 `json:"agents"`
			Users                  struct {
				Total, Operators, Reviewers, Members float64
			} `json:"users"`
		} `json:"totals"`
		Growth struct {
			Weeks []map[string]any `json:"weeks"`
		} `json:"growth"`
		Activity map[string]any `json:"activity"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Totals.Organizations != 3 || out.Totals.OrganizationsSuspended != 1 ||
		out.Totals.Projects != 7 || out.Totals.Agents != 11 {
		t.Errorf("totals = %+v", out.Totals)
	}
	if out.Totals.Users.Total != 40 || out.Totals.Users.Members != 34 {
		t.Errorf("users = %+v", out.Totals.Users)
	}
	if len(out.Growth.Weeks) != 12 {
		t.Fatalf("weeks = %d, want 12 zero-filled buckets", len(out.Growth.Weeks))
	}
	last := out.Growth.Weeks[11]
	if last["week_start"] != monday || last["users"] != float64(5) || last["organizations"] != float64(2) {
		t.Errorf("current week bucket = %v", last)
	}
	if out.Growth.Weeks[0]["users"] != float64(0) {
		t.Errorf("oldest bucket must be zero-filled, got %v", out.Growth.Weeks[0])
	}
	if out.Activity["available"] != true || out.Activity["sessions_30d"] != float64(150) ||
		out.Activity["events_30d"] != float64(10000) || out.Activity["orgs_active_30d"] != float64(2) {
		t.Errorf("activity = %v", out.Activity)
	}
	top, _ := out.Activity["top_orgs"].([]any)
	if len(top) != 2 {
		t.Fatalf("top_orgs = %v", top)
	}
	first, _ := top[0].(map[string]any)
	if first["slug"] != "acme" || first["sessions_30d"] != float64(120) {
		t.Errorf("top org = %v", first)
	}
	if len(ch.sql) != 1 || !strings.Contains(ch.sql[0], "session_stats_agg FINAL") ||
		!strings.Contains(ch.sql[0], "LIMIT 100001") {
		t.Errorf("activity query must deduplicate and stay bounded: %v", ch.sql)
	}
}

func TestOverviewReportsActivityUnavailableNotZero(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		countersStub(1, 0, 1, 1, 1, 0, 0),
		{match: "date_trunc('week'"},
	}}
	ch := &fakeCH{err: errors.New("ch down")}
	rec := serve(t, &Handler{DB: db, CH: ch}, "operator", http.MethodGet, "/api/v1/operator/overview", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Activity map[string]any `json:"activity"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Activity["available"] != false {
		t.Errorf("cold ClickHouse must report unavailable, got %v", out.Activity)
	}
	if _, present := out.Activity["sessions_30d"]; present {
		t.Errorf("unavailable activity must not fabricate counts: %v", out.Activity)
	}
}

func orgPageStub(match string) stub {
	created := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	suspended := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	return stub{match: match, rows: [][]any{
		{orgA, "acme", "Acme Corp", created, nil, int64(9), int64(3), "owner@acme.io"},
		{orgB, "beta", "Beta LLC", created, suspended, int64(1), int64(1), nil},
	}}
}

func TestOrganizationsPaginatedEnvelope(t *testing.T) {
	ch, extra := activityStubs()
	db := &fakeDB{stubs: append([]stub{
		{match: "SELECT count(*) FROM organizations o", rows: [][]any{{int64(23)}}},
		orgPageStub("o.id::text AS id"),
	}, extra...)}
	rec := serve(t, &Handler{DB: db, CH: ch}, "operator", http.MethodGet,
		"/api/v1/operator/orgs?limit=2&offset=4", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Items    []map[string]any `json:"items"`
		Total    float64          `json:"total"`
		Limit    float64          `json:"limit"`
		Offset   float64          `json:"offset"`
		Activity string           `json:"activity"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Total != 23 || out.Limit != 2 || out.Offset != 4 || out.Activity != "ok" {
		t.Errorf("envelope = total %v limit %v offset %v activity %q",
			out.Total, out.Limit, out.Offset, out.Activity)
	}
	if len(out.Items) != 2 {
		t.Fatalf("items = %v", out.Items)
	}
	if out.Items[0]["slug"] != "acme" || out.Items[0]["member_count"] != float64(9) ||
		out.Items[0]["owner_email"] != "owner@acme.io" || out.Items[0]["suspended_at"] != nil {
		t.Errorf("first org = %v", out.Items[0])
	}
	if out.Items[0]["sessions_30d"] != float64(120) {
		t.Errorf("activity not attached: %v", out.Items[0])
	}
	if out.Items[1]["suspended_at"] != "2026-09-01T00:00:00Z" || out.Items[1]["owner_email"] != nil {
		t.Errorf("second org = %v", out.Items[1])
	}
	var pageSQL string
	for _, sql := range db.sql {
		if strings.Contains(sql, "o.id::text AS id") {
			pageSQL = sql
		}
	}
	if !strings.Contains(pageSQL, "LIMIT 2 OFFSET 4") {
		t.Errorf("page SQL not bounded: %s", pageSQL)
	}
	// The tenant list is metadata-only: no content tables may be touched.
	for _, sql := range db.sql {
		for _, forbidden := range []string{"agents", "mcp_listings", "skill_listings"} {
			if strings.Contains(sql, forbidden) {
				t.Errorf("tenant list reads content table %q: %s", forbidden, sql)
			}
		}
	}
}

func TestOrganizationsSearchAndSort(t *testing.T) {
	ch, extra := activityStubs()
	db := &fakeDB{stubs: append([]stub{
		{match: "SELECT count(*) FROM organizations o", rows: [][]any{{int64(1)}}},
		orgPageStub("o.id::text AS id"),
	}, extra...)}
	rec := serve(t, &Handler{DB: db, CH: ch}, "operator", http.MethodGet,
		"/api/v1/operator/orgs?q=ac%25me&sort=members&order=asc", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	var pageSQL string
	var pageArgs []any
	for i, sql := range db.sql {
		if strings.Contains(sql, "o.id::text AS id") {
			pageSQL, pageArgs = sql, db.args[i]
		}
	}
	if !strings.Contains(pageSQL, "ORDER BY member_count ASC") ||
		!strings.Contains(pageSQL, "created_at DESC, id ASC") {
		t.Errorf("sort not applied: %s", pageSQL)
	}
	if !strings.Contains(pageSQL, "ILIKE") {
		t.Errorf("search not applied: %s", pageSQL)
	}
	if len(pageArgs) != 1 || pageArgs[0] != `%ac\%me%` {
		t.Errorf("ILIKE metacharacters not escaped: %v", pageArgs)
	}
}

func TestOrganizationsRejectsBadParams(t *testing.T) {
	db := &fakeDB{}
	for _, target := range []string{
		"/api/v1/operator/orgs?sort=drop_table",
		"/api/v1/operator/orgs?order=sideways",
		"/api/v1/operator/orgs?status=zombie",
		"/api/v1/operator/orgs?limit=lots",
		"/api/v1/operator/orgs?offset=-1",
	} {
		rec := serve(t, &Handler{DB: db}, "operator", http.MethodGet, target, "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", target, rec.Code)
		}
	}
	if len(db.sql) != 0 {
		t.Errorf("invalid params reached storage: %v", db.sql)
	}
}

func TestOrganizationsActivitySort(t *testing.T) {
	ch, extra := activityStubs()
	created := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	db := &fakeDB{stubs: append([]stub{
		{match: "SELECT count(*) FROM organizations o", rows: [][]any{{int64(2)}}},
		{match: "SELECT o.id::text, o.created_at FROM organizations o", rows: [][]any{
			{orgB, created},
			{orgA, created},
		}},
		orgPageStub("o.id::text AS id"),
	}, extra...)}
	rec := serve(t, &Handler{DB: db, CH: ch}, "operator", http.MethodGet,
		"/api/v1/operator/orgs?sort=activity", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Items []map[string]any `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Items) != 2 || out.Items[0]["id"] != orgA || out.Items[1]["id"] != orgB {
		t.Errorf("activity ranking wrong: %v", out.Items)
	}
}

func TestOrganizationsActivitySortUnavailable(t *testing.T) {
	db := &fakeDB{}
	ch := &fakeCH{err: errors.New("ch down")}
	rec := serve(t, &Handler{DB: db, CH: ch}, "operator", http.MethodGet,
		"/api/v1/operator/orgs?sort=activity", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("activity sort with cold ClickHouse: status = %d, want 503", rec.Code)
	}
}

func TestOrganizationsActivityUnavailableIsNull(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT count(*) FROM organizations o", rows: [][]any{{int64(2)}}},
		orgPageStub("o.id::text AS id"),
	}}
	ch := &fakeCH{err: errors.New("ch down")}
	rec := serve(t, &Handler{DB: db, CH: ch}, "operator", http.MethodGet, "/api/v1/operator/orgs", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Items    []map[string]any `json:"items"`
		Activity string           `json:"activity"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Activity != "unavailable" {
		t.Errorf("activity = %q, want unavailable", out.Activity)
	}
	if out.Items[0]["sessions_30d"] != nil {
		t.Errorf("unavailable activity must be null, not fabricated: %v", out.Items[0])
	}
}

func lifecycleDB(suspended any) *fakeDB {
	return &fakeDB{
		stubs: []stub{
			{match: "SELECT slug, suspended_at FROM organizations", rows: [][]any{{"acme", suspended}}},
			{match: "SET suspended_at = now()", rows: [][]any{{time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}}},
		},
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
}

func TestSuspendRequiresSlugConfirmation(t *testing.T) {
	db := lifecycleDB(nil)
	rec := serve(t, &Handler{DB: db}, "operator", http.MethodPost,
		"/api/v1/operator/orgs/"+orgA+"/suspend", `{"confirm":"wrong"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("mismatched confirmation: status = %d, want 400", rec.Code)
	}
	if len(db.execSQL) != 0 {
		t.Errorf("mismatched confirmation reached storage: %v", db.execSQL)
	}
}

func TestSuspendAndReinstate(t *testing.T) {
	db := lifecycleDB(nil)
	rec := serve(t, &Handler{DB: db}, "operator", http.MethodPost,
		"/api/v1/operator/orgs/"+orgA+"/suspend", `{"confirm":"acme"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("suspend: status = %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["suspended_at"] != "2026-09-01T00:00:00Z" || out["slug"] != "acme" {
		t.Errorf("suspend response = %v", out)
	}

	// Suspending an already-suspended org conflicts.
	db2 := lifecycleDB(time.Now().UTC())
	rec = serve(t, &Handler{DB: db2}, "operator", http.MethodPost,
		"/api/v1/operator/orgs/"+orgA+"/suspend", `{"confirm":"acme"}`)
	if rec.Code != http.StatusConflict {
		t.Errorf("double suspend: status = %d, want 409", rec.Code)
	}

	// Reinstating a suspended org succeeds.
	rec = serve(t, &Handler{DB: db2}, "operator", http.MethodPost,
		"/api/v1/operator/orgs/"+orgA+"/reinstate", `{"confirm":"acme"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("reinstate: status = %d %s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["suspended_at"] != nil {
		t.Errorf("reinstate response = %v", out)
	}

	// Reinstating an active org conflicts.
	rec = serve(t, &Handler{DB: lifecycleDB(nil)}, "operator", http.MethodPost,
		"/api/v1/operator/orgs/"+orgA+"/reinstate", `{"confirm":"acme"}`)
	if rec.Code != http.StatusConflict {
		t.Errorf("reinstate active: status = %d, want 409", rec.Code)
	}
}

func TestDeleteRequiresSuspensionFirst(t *testing.T) {
	lc := &fakeLifecycle{}
	rec := serve(t, &Handler{DB: lifecycleDB(nil), Orgs: lc}, "operator", http.MethodDelete,
		"/api/v1/operator/orgs/"+orgA, `{"confirm":"acme"}`)
	if rec.Code != http.StatusConflict {
		t.Errorf("delete active org: status = %d, want 409", rec.Code)
	}
	if lc.got != nil {
		t.Errorf("delete ran without suspension")
	}
}

func TestDeleteSuspendedOrg(t *testing.T) {
	lc := &fakeLifecycle{}
	rec := serve(t, &Handler{DB: lifecycleDB(time.Now().UTC()), Orgs: lc}, "operator",
		http.MethodDelete, "/api/v1/operator/orgs/"+orgA, `{"confirm":"acme"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: status = %d %s", rec.Code, rec.Body.String())
	}
	if lc.got == nil || lc.got.ID.String() != orgA || lc.got.Slug != "acme" {
		t.Errorf("lifecycle got %+v", lc.got)
	}

	// Non-empty organizations are refused with the shared tenancy detail.
	lc2 := &fakeLifecycle{err: &tenancy.Error{Status: 409, Detail: "Organization still contains 2 project(s); delete or migrate them first"}}
	rec = serve(t, &Handler{DB: lifecycleDB(time.Now().UTC()), Orgs: lc2}, "operator",
		http.MethodDelete, "/api/v1/operator/orgs/"+orgA, `{"confirm":"acme"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "still contains") {
		t.Errorf("non-empty delete: status = %d %s", rec.Code, rec.Body.String())
	}
}

func TestLifecycleUnknownOrg(t *testing.T) {
	db := &fakeDB{}
	for _, tc := range []struct{ method, target string }{
		{http.MethodPost, "/api/v1/operator/orgs/not-a-uuid/suspend"},
		{http.MethodPost, "/api/v1/operator/orgs/" + orgA + "/suspend"},
		{http.MethodDelete, "/api/v1/operator/orgs/" + orgA},
	} {
		rec := serve(t, &Handler{DB: db}, "operator", tc.method, tc.target, `{"confirm":"acme"}`)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s: status = %d, want 404", tc.method, tc.target, rec.Code)
		}
	}
}

func TestOperatorFloorBlocksTenantRoles(t *testing.T) {
	db := &fakeDB{}
	h := &Handler{DB: db}
	// Org owners/admins hold deployment role "user": the control plane must
	// reject them and anonymous callers outright.
	targets := []struct{ method, target string }{
		{http.MethodGet, "/api/v1/operator/overview"},
		{http.MethodGet, "/api/v1/operator/orgs"},
		{http.MethodPost, "/api/v1/operator/orgs/" + orgA + "/suspend"},
		{http.MethodPost, "/api/v1/operator/orgs/" + orgA + "/reinstate"},
		{http.MethodDelete, "/api/v1/operator/orgs/" + orgA},
	}
	for _, role := range []string{"user", "reviewer", "admin", "super_admin", ""} {
		for _, tc := range targets {
			rec := serve(t, h, role, tc.method, tc.target, `{"confirm":"x"}`)
			want := http.StatusForbidden
			if role == "" {
				want = http.StatusUnauthorized
			}
			if rec.Code != want {
				t.Errorf("role %q %s %s: status = %d, want %d", role, tc.method, tc.target, rec.Code, want)
			}
		}
	}
	if len(db.sql) != 0 {
		t.Errorf("denied requests reached storage: %v", db.sql)
	}
}
