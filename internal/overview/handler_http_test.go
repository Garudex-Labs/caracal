// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package overview

import (
	"context"
	"encoding/json"
	"errors"
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

// ── Postgres fake ────────────────────────────────────────────────────────────

// fakeRows implements pgx.Rows over literal row data.
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
			switch v := row[i].(type) {
			case int:
				*p = int64(v)
			case int64:
				*p = v
			}
		default:
			return fmt.Errorf("unsupported scan destination %T", d)
		}
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

type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }

// stub answers queries whose SQL contains the match fragment.
type stub struct {
	match string
	rows  *fakeRows
}

// fakeDB routes queries to stubs by SQL substring, recording statements
// and bound arguments.
type fakeDB struct {
	mu    sync.Mutex
	stubs []stub
	err   error // when set, every query fails with it
	log   []string
	args  [][]any
}

func (db *fakeDB) route(sql string, args []any) (*fakeRows, error) {
	db.mu.Lock()
	db.log = append(db.log, sql)
	db.args = append(db.args, args)
	db.mu.Unlock()
	if db.err != nil {
		return nil, db.err
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
	return db.route(sql, args)
}

func (db *fakeDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	rows, err := db.route(sql, args)
	if err != nil {
		return errRow{err}
	}
	return fakeRow{rows}
}

// ── ClickHouse fake ──────────────────────────────────────────────────────────

// chBackend plays ClickHouse over HTTP, capturing SQL and bound settings.
type chBackend struct {
	mu     sync.Mutex
	rows   []map[string]any
	fail   bool
	log    []string
	params []url.Values
}

func (b *chBackend) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	b.mu.Lock()
	b.log = append(b.log, r.URL.Query().Get("query")+string(body))
	b.params = append(b.params, r.URL.Query())
	fail := b.fail
	rows := b.rows
	b.mu.Unlock()
	if fail {
		http.Error(w, "Code: 999. DB::Exception: boom-ch-secret", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if rows == nil {
		rows = []map[string]any{}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
}

// ── Harness ──────────────────────────────────────────────────────────────────

func newHandler(t *testing.T, db *fakeDB, backend *chBackend) *Handler {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(backend.handler))
	t.Cleanup(server.Close)
	ch, err := clickhouse.New(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return &Handler{
		Store: &Store{DB: db, CH: ch},
		Now:   func() time.Time { return time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC) },
	}
}

func serveOverview(h *Handler, target string, claims *auth.Claims) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if claims != nil {
		req = req.WithContext(httpapi.ContextWithClaims(req.Context(), *claims))
	}
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func operatorClaims() *auth.Claims {
	return &auth.Claims{
		UserID: uuid.MustParse("22222222-2222-2222-2222-222222222222"),
		Role:   "operator",
	}
}

func statsStub() stub {
	return stub{match: "count(l.id) FROM mcp_listings",
		rows: &fakeRows{rows: [][]any{{int64(3), int64(2), int64(10)}}}}
}

type wireStats struct {
	TotalMcps              int64 `json:"total_mcps"`
	TotalAgents            int64 `json:"total_agents"`
	TotalUsers             int64 `json:"total_users"`
	TotalToolCalls         int64 `json:"total_tool_calls"`
	TotalAgentInteractions int64 `json:"total_agent_interactions"`
}

func decodeStats(t *testing.T, rec *httptest.ResponseRecorder) wireStats {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out wireStats
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

// ── Tests ────────────────────────────────────────────────────────────────────

func TestStatsCombinesCatalogAndUsageCounters(t *testing.T) {
	db := &fakeDB{stubs: []stub{statsStub()}}
	backend := &chBackend{rows: []map[string]any{{"calls": "42", "sessions": "7"}}}
	h := newHandler(t, db, backend)

	out := decodeStats(t, serveOverview(h, "/api/v1/overview/stats?range=30d", operatorClaims()))
	want := wireStats{TotalMcps: 3, TotalAgents: 2, TotalUsers: 10,
		TotalToolCalls: 42, TotalAgentInteractions: 7}
	if out != want {
		t.Errorf("stats = %+v, want %+v", out, want)
	}
	if len(backend.params) != 1 || backend.params[0].Get("param_days") != "30" {
		t.Errorf("analytics window not bound to range: %v", backend.params)
	}
	if len(db.log) != 1 || strings.Contains(db.log[0], "AND TRUE") || !strings.Contains(db.log[0], "l.submitted_by = $1") {
		t.Errorf("operator visibility clause must stay scoped: %v", db.log)
	}
}

func TestStatsScopesAnonymousViewersToPublicRows(t *testing.T) {
	db := &fakeDB{stubs: []stub{statsStub()}}
	h := newHandler(t, db, &chBackend{})

	rec := serveOverview(h, "/api/v1/overview/stats", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if len(db.log) != 1 {
		t.Fatalf("statements = %v", db.log)
	}
	for _, frag := range []string{"l.is_private = FALSE", "a.is_private = FALSE"} {
		if !strings.Contains(db.log[0], frag) {
			t.Errorf("anonymous query missing %q:\n%s", frag, db.log[0])
		}
	}
}

func TestStatsSurvivesAnalyticsStoreOutage(t *testing.T) {
	db := &fakeDB{stubs: []stub{statsStub()}}
	h := newHandler(t, db, &chBackend{fail: true})

	out := decodeStats(t, serveOverview(h, "/api/v1/overview/stats", operatorClaims()))
	if out.TotalMcps != 3 || out.TotalAgents != 2 || out.TotalUsers != 10 {
		t.Errorf("catalog counters lost: %+v", out)
	}
	if out.TotalToolCalls != 0 || out.TotalAgentInteractions != 0 {
		t.Errorf("usage counters should degrade to zero: %+v", out)
	}
}

func TestStorageFailuresAnswerSanitized500(t *testing.T) {
	for _, target := range []string{
		"/api/v1/overview/stats",
		"/api/v1/overview/top-mcps",
		"/api/v1/overview/top-agents",
		"/api/v1/overview/trends",
	} {
		db := &fakeDB{err: errors.New("pg exploded password=hunter2")}
		h := newHandler(t, db, &chBackend{})
		rec := serveOverview(h, target, operatorClaims())
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("%s = %d: %s", target, rec.Code, rec.Body.String())
			continue
		}
		var body struct {
			Detail string `json:"detail"`
			Code   string `json:"code"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body.Detail != "Internal server error" || body.Code != "internal_error" {
			t.Errorf("%s body = %s", target, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "hunter2") {
			t.Errorf("%s leaked the storage error: %s", target, rec.Body.String())
		}
	}
}

func TestTopMcpsRendersDownloadLeadersWithExplicitFraction(t *testing.T) {
	db := &fakeDB{stubs: []stub{{
		match: "mcp_downloads",
		rows: &fakeRows{rows: [][]any{
			{"aaaaaaaa-0000-0000-0000-000000000001", int64(12), "GitHub MCP"},
			{"aaaaaaaa-0000-0000-0000-000000000002", int64(4), "Filesystem MCP"},
		}},
	}}}
	h := newHandler(t, db, &chBackend{})

	rec := serveOverview(h, "/api/v1/overview/top-mcps", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []struct {
		ID    string      `json:"id"`
		Name  string      `json:"name"`
		Value json.Number `json:"value"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Name != "GitHub MCP" || out[0].Value != "12.0" ||
		out[1].Value != "4.0" {
		t.Fatalf("top-mcps = %s", rec.Body.String())
	}
	// Integral counts keep the trailing zero on the wire, not just in Go.
	if !strings.Contains(rec.Body.String(), `"value":12.0`) {
		t.Errorf("wire value lost its fraction: %s", rec.Body.String())
	}
	if !strings.Contains(db.log[0], "l.is_private = FALSE") {
		t.Errorf("anonymous top-mcps not scoped to public rows:\n%s", db.log[0])
	}
}

func TestTopMcpsEmptyResultIsEmptyList(t *testing.T) {
	h := newHandler(t, &fakeDB{}, &chBackend{})
	rec := serveOverview(h, "/api/v1/overview/top-mcps", nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("empty top-mcps = %d %q", rec.Code, rec.Body.String())
	}
}

func TestTopAgentsProjectsQualifiedNameAndLatestRelease(t *testing.T) {
	db := &fakeDB{stubs: []stub{{
		match: "agent_download_records",
		rows: &fakeRows{rows: [][]any{
			{"bbbbbbbb-0000-0000-0000-000000000001", int64(9), "Helper", "acme", "helper",
				"Does things", nil, "1.2.0"},
		}},
	}}}
	h := newHandler(t, db, &chBackend{})

	rec := serveOverview(h, "/api/v1/overview/top-agents", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []struct {
		ID                string  `json:"id"`
		QualifiedName     string  `json:"qualified_name"`
		Description       string  `json:"description"`
		Owner             string  `json:"owner"`
		CreatedByUsername *string `json:"created_by_username"`
		Version           string  `json:"version"`
		DownloadCount     int64   `json:"download_count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("top-agents = %s", rec.Body.String())
	}
	a := out[0]
	if a.QualifiedName != "acme/helper" || a.Description != "Does things" ||
		a.Owner != "" || a.Version != "1.2.0" || a.DownloadCount != 9 ||
		a.CreatedByUsername != nil {
		t.Errorf("agent = %+v", a)
	}
	// The default limit rides as the final bound argument.
	if args := db.args[0]; len(args) == 0 || args[len(args)-1] != 6 {
		t.Errorf("default limit not bound: %v", args)
	}

	rec = serveOverview(h, "/api/v1/overview/top-agents?limit=2", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("limit=2 status = %d", rec.Code)
	}
	if args := db.args[1]; len(args) == 0 || args[len(args)-1] != 2 {
		t.Errorf("explicit limit not bound: %v", args)
	}
}

func TestTopAgentsInvalidLimitNeverReachesStorage(t *testing.T) {
	db := &fakeDB{}
	h := newHandler(t, db, &chBackend{})
	for _, raw := range []string{"limit=abc", "limit=99", "limit=0"} {
		rec := serveOverview(h, "/api/v1/overview/top-agents?"+raw, nil)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s = %d: %s", raw, rec.Code, rec.Body.String())
		}
	}
	if len(db.log) != 0 {
		t.Errorf("validation failures reached storage: %v", db.log)
	}
}

func TestTrendsMergesSubmissionAndSignupSeries(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings WHERE",
			rows: &fakeRows{rows: [][]any{{"2026-08-02", int64(3)}}}},
		{match: "FROM users WHERE",
			rows: &fakeRows{rows: [][]any{{"2026-08-01", int64(5)}, {"2026-08-02", int64(1)}}}},
	}}
	h := newHandler(t, db, &chBackend{})

	rec := serveOverview(h, "/api/v1/overview/trends?range=24h", operatorClaims())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []struct {
		Date        string `json:"date"`
		Submissions int64  `json:"submissions"`
		Users       int64  `json:"users"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 ||
		out[0].Date != "2026-08-01" || out[0].Submissions != 0 || out[0].Users != 5 ||
		out[1].Date != "2026-08-02" || out[1].Submissions != 3 || out[1].Users != 1 {
		t.Fatalf("trends = %s", rec.Body.String())
	}
	// The window start derives from the injected clock and the range param.
	wantStart := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	if args := db.args[0]; len(args) != 1 || !args[0].(time.Time).Equal(wantStart) {
		t.Errorf("window start = %v, want %v", db.args[0], wantStart)
	}
}
