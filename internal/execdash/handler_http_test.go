// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

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
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/clickhouse"
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
			s, _ := row[i].(string)
			*p = s
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
		case *float64:
			switch v := row[i].(type) {
			case float64:
				*p = v
			case int:
				*p = float64(v)
			}
		case *uuid.UUID:
			switch v := row[i].(type) {
			case uuid.UUID:
				*p = v
			case string:
				*p = uuid.MustParse(v)
			}
		case *map[string]any:
			m, _ := row[i].(map[string]any)
			*p = m
		case **time.Time:
			if row[i] == nil {
				*p = nil
			} else {
				ts, _ := row[i].(time.Time)
				*p = &ts
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

// dbStub answers queries whose SQL contains the match fragment.
type dbStub struct {
	match string
	rows  [][]any
}

// fakeDB routes queries to stubs by SQL substring, recording statements
// and bound arguments.
type fakeDB struct {
	mu       sync.Mutex
	stubs    []dbStub
	err      error // when set, every query fails with it
	execErr  error
	queryLog []string
	execLog  []string
	execArgs [][]any
}

func (db *fakeDB) route(sql string) (*fakeRows, error) {
	db.mu.Lock()
	db.queryLog = append(db.queryLog, sql)
	db.mu.Unlock()
	if db.err != nil {
		return nil, db.err
	}
	for _, s := range db.stubs {
		if strings.Contains(sql, s.match) {
			return &fakeRows{rows: s.rows}, nil
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

func (db *fakeDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.mu.Lock()
	db.execLog = append(db.execLog, sql)
	db.execArgs = append(db.execArgs, args)
	db.mu.Unlock()
	return pgconn.CommandTag{}, db.execErr
}

// ── ClickHouse fake ──────────────────────────────────────────────────────────

// chStub answers statements containing every needle.
type chStub struct {
	needles []string
	rows    []map[string]any
}

// chBackend plays ClickHouse over HTTP, routing by SQL substrings and
// capturing statements plus bound parameters.
type chBackend struct {
	mu     sync.Mutex
	stubs  []chStub
	fail   bool
	log    []string
	params []url.Values
}

func (b *chBackend) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	sql := r.URL.Query().Get("query") + string(body)
	b.mu.Lock()
	b.log = append(b.log, sql)
	b.params = append(b.params, r.URL.Query())
	fail := b.fail
	stubs := b.stubs
	b.mu.Unlock()
	if fail {
		http.Error(w, "Code: 999. DB::Exception: boom-ch-secret", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	for _, s := range stubs {
		matched := true
		for _, needle := range s.needles {
			if !strings.Contains(sql, needle) {
				matched = false
				break
			}
		}
		if matched {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": s.rows})
			return
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{}})
}

// chParam returns the first captured value for a settings parameter.
func (b *chBackend) chParam(name string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, p := range b.params {
		if v := p.Get(name); v != "" {
			return v
		}
	}
	return ""
}

// ── Harness ──────────────────────────────────────────────────────────────────

func newExecHandler(t *testing.T, db *fakeDB, backend *chBackend) *Handler {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(backend.handler))
	t.Cleanup(server.Close)
	ch, err := clickhouse.New(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return &Handler{Store: &Store{DB: db, CH: ch}}
}

func serveExec(h *Handler, method, target, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func decodeMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func decodeList(t *testing.T, rec *httptest.ResponseRecorder) []any {
	t.Helper()
	var body []any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

var (
	agentA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	agentB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	userU1 = "11111111-1111-1111-1111-111111111111"
	userU2 = "22222222-2222-2222-2222-222222222222"
	userU3 = "33333333-3333-3333-3333-333333333333"
)

// ── Adoption ─────────────────────────────────────────────────────────────────

func TestAdoptionAggregates(t *testing.T) {
	db := &fakeDB{stubs: []dbStub{
		{match: "count(id) FROM users", rows: [][]any{{10}}},
		{match: "DISTINCT group_name FROM user_groups", rows: [][]any{{"Engineering"}}},
		{match: "SELECT DISTINCT department FROM users", rows: [][]any{{"Sales"}}},
	}}
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"toStartOfMonth(now())"}, rows: []map[string]any{{"active": "4"}}},
		{needles: []string{"GROUP BY month ORDER BY month"}, rows: []map[string]any{
			{"month": "2026-07-01", "active": "5"},
		}},
	}}
	h := newExecHandler(t, db, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/adoption", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec)
	if body["total_users"] != float64(10) || body["active_users"] != float64(4) {
		t.Fatalf("user counts: %v", body)
	}
	if body["current_pct"] != float64(40) {
		t.Fatalf("current_pct = %v", body["current_pct"])
	}
	if body["departments_covered"] != float64(2) {
		t.Fatalf("departments_covered = %v", body["departments_covered"])
	}
	monthly := body["monthly"].([]any)
	if len(monthly) != 1 {
		t.Fatalf("monthly = %v", monthly)
	}
	point := monthly[0].(map[string]any)
	if point["month"] != "2026-07" || point["adoption_pct"] != float64(50) {
		t.Fatalf("monthly point = %v", point)
	}
}

func TestAdoptionDBFailureIsSanitized(t *testing.T) {
	db := &fakeDB{err: errors.New("pg down: password=hunter2")}
	h := newExecHandler(t, db, &chBackend{})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/adoption", "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatalf("internal detail leaked: %s", rec.Body.String())
	}
	if body := decodeMap(t, rec); body["detail"] != "Internal server error" {
		t.Fatalf("body = %v", body)
	}
}

// ── Agent counts ─────────────────────────────────────────────────────────────

func TestAgentCounts(t *testing.T) {
	db := &fakeDB{stubs: []dbStub{
		{match: "count(*) FROM agents", rows: [][]any{{7}}},
		{match: "v.status = 'approved'", rows: [][]any{{3}}},
		{match: "IN ('pending', 'draft')", rows: [][]any{{2}}},
		{match: "SELECT category, count(id) FROM agents GROUP BY category", rows: [][]any{
			{"Coding", 4},
			{nil, 3},
		}},
	}}
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"count(DISTINCT agent_id)"}, rows: []map[string]any{{"cnt": "5"}}},
	}}
	h := newExecHandler(t, db, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/agent-counts", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec)
	if body["total"] != float64(7) || body["active"] != float64(5) ||
		body["published"] != float64(3) || body["in_development"] != float64(2) {
		t.Fatalf("counts: %v", body)
	}
	categories := body["by_category"].([]any)
	if len(categories) != 2 {
		t.Fatalf("by_category = %v", categories)
	}
	second := categories[1].(map[string]any)
	if second["category"] != "Uncategorized" || second["count"] != float64(3) {
		t.Fatalf("nil category must become Uncategorized: %v", second)
	}
}

// ── Usage by category ────────────────────────────────────────────────────────

func TestUsageByCategoryGrowth(t *testing.T) {
	db := &fakeDB{stubs: []dbStub{
		{match: "SELECT id::text, category FROM agents WHERE id = ANY", rows: [][]any{
			{agentA, "Coding"},
		}},
	}}
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"{days2:UInt32}"}, rows: []map[string]any{
			{"agent_id": agentA, "cnt": "15"},
		}},
		{needles: []string{"INTERVAL {days:UInt32} DAY"}, rows: []map[string]any{
			{"agent_id": agentA, "cnt": "30"},
			{"agent_id": "not-a-uuid", "cnt": "5"},
		}},
	}}
	h := newExecHandler(t, db, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/usage-by-category?range=24h", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	items := decodeList(t, rec)
	if len(items) != 2 {
		t.Fatalf("items = %v", items)
	}
	first := items[0].(map[string]any)
	if first["category"] != "Coding" || first["sessions"] != float64(30) || first["growth_pct"] != float64(100) {
		t.Fatalf("first = %v", first)
	}
	// Non-UUID agent ids bucket into Uncategorized rather than vanish.
	second := items[1].(map[string]any)
	if second["category"] != "Uncategorized" || second["sessions"] != float64(5) {
		t.Fatalf("second = %v", second)
	}
	// The 24h range must bind one day into the store query.
	if got := backend.chParam("param_days"); got != "1" {
		t.Fatalf("param_days = %q", got)
	}
}

func TestUsageByCategoryCHFailureDegradesToEmpty(t *testing.T) {
	h := newExecHandler(t, &fakeDB{}, &chBackend{fail: true})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/usage-by-category", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Fatalf("body = %s, want []", got)
	}
	if strings.Contains(rec.Body.String(), "boom-ch-secret") {
		t.Fatal("store error leaked")
	}
}

// ── Platforms ────────────────────────────────────────────────────────────────

func TestPlatformCoverage(t *testing.T) {
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"GROUP BY harness ORDER BY sessions DESC"}, rows: []map[string]any{
			{"harness": "kiro", "users": "3", "sessions": "20"},
			{"harness": "cursor", "users": "1", "sessions": "5"},
		}},
	}}
	h := newExecHandler(t, &fakeDB{}, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/platform-coverage", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	items := decodeList(t, rec)
	if len(items) != 2 {
		t.Fatalf("items = %v", items)
	}
	first := items[0].(map[string]any)
	if first["platform"] != "kiro" || first["users"] != float64(3) || first["sessions"] != float64(20) {
		t.Fatalf("first = %v", first)
	}
}

func TestPlatformsCompositeScore(t *testing.T) {
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"avg_latency_ms"}, rows: []map[string]any{
			{"harness": "kiro", "sessions": "20", "users": "3", "avg_latency_ms": 1200.5},
			{"harness": "cursor", "sessions": "5", "users": "1", "avg_latency_ms": "800.0"},
		}},
	}}
	h := newExecHandler(t, &fakeDB{}, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/platforms", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	items := decodeList(t, rec)
	if len(items) != 2 {
		t.Fatalf("items = %v", items)
	}
	first := items[0].(map[string]any)
	if first["composite_score"] != float64(100) || first["avg_latency_ms"] != 1200.5 {
		t.Fatalf("first = %v", first)
	}
	second := items[1].(map[string]any)
	if second["composite_score"] != float64(25) || second["avg_latency_ms"] != float64(800) {
		t.Fatalf("second = %v", second)
	}
}

// ── Velocity ─────────────────────────────────────────────────────────────────

func TestVelocityBaselineWindows(t *testing.T) {
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"toStartOfWeek"}, rows: []map[string]any{
			{"week": "2026-06-29", "traces": "10"},
			{"week": "2026-07-06", "traces": "10"},
			{"week": "2026-07-13", "traces": "10"},
			{"week": "2026-07-20", "traces": "10"},
			{"week": "2026-07-27", "traces": "30"},
		}},
	}}
	h := newExecHandler(t, &fakeDB{}, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/velocity", "")
	body := decodeMap(t, rec)
	if body["baseline_weekly_avg"] != float64(10) || body["current_weekly_avg"] != float64(15) {
		t.Fatalf("averages: %v", body)
	}
	if body["multiplier"] != 1.5 {
		t.Fatalf("multiplier = %v", body["multiplier"])
	}
	weekly := body["weekly"].([]any)
	if len(weekly) != 5 {
		t.Fatalf("weekly = %v", weekly)
	}
	if weekly[0].(map[string]any)["week"] != "2026-06-29" {
		t.Fatalf("week = %v", weekly[0])
	}
}

// ── Top agents ───────────────────────────────────────────────────────────────

func TestTopAgentsRanking(t *testing.T) {
	db := &fakeDB{stubs: []dbStub{
		{match: "FROM agent_download_records", rows: [][]any{
			{agentA, 10},
			{agentB, 30},
		}},
		{match: "SELECT id::text, name, category FROM agents WHERE id = ANY", rows: [][]any{
			{agentA, "Refactor Bot", "Coding"},
			{agentB, "Docs Bot", nil},
		}},
	}}
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"LIMIT 50"}, rows: []map[string]any{
			{"agent_id": agentA, "sessions": "50"},
		}},
		{needles: []string{"INTERVAL 6 WEEK"}, rows: []map[string]any{
			{"agent_id": agentA, "week": "2026-07-20", "cnt": "1"},
			{"agent_id": agentA, "week": "2026-07-27", "cnt": "2"},
		}},
	}}
	h := newExecHandler(t, db, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/top-agents", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	items := decodeList(t, rec)
	if len(items) != 2 {
		t.Fatalf("items = %v", items)
	}
	first := items[0].(map[string]any)
	// downloads 10/30 normalized (13.3) plus sessions 50/50 (60.0).
	if first["id"] != agentA || first["composite_score"] != 73.3 {
		t.Fatalf("first = %v", first)
	}
	trend := first["weekly_trend"].([]any)
	if len(trend) != 2 || trend[1] != float64(2) {
		t.Fatalf("trend = %v", trend)
	}
	second := items[1].(map[string]any)
	if second["name"] != "Docs Bot" || second["category"] != "Uncategorized" || second["composite_score"] != float64(40) {
		t.Fatalf("second = %v", second)
	}
	// Download-only agents keep an empty (not null) trend.
	if raw, _ := json.Marshal(second["weekly_trend"]); string(raw) != "[]" {
		t.Fatalf("second trend = %v", second["weekly_trend"])
	}
}

func TestTopAgentsLimitValidation(t *testing.T) {
	h := newExecHandler(t, &fakeDB{}, &chBackend{})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/top-agents?limit=51", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"type":"less_than_equal"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// ── Departments ──────────────────────────────────────────────────────────────

func deptDB() *fakeDB {
	return &fakeDB{stubs: []dbStub{
		{match: "SELECT group_name, user_id::text FROM user_groups", rows: [][]any{
			{"Engineering", userU1},
		}},
		{match: "id::text, department FROM users", rows: [][]any{
			{userU2, "Sales"},
		}},
		{match: "SELECT id::text FROM users", rows: [][]any{
			{userU1}, {userU2}, {userU3},
		}},
		{match: "created_by::text, count(id) FROM agents GROUP BY created_by", rows: [][]any{
			{userU1, 2},
		}},
	}}
}

func TestDepartmentsBreakdown(t *testing.T) {
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"GROUP BY user_id", "{days:UInt32}"}, rows: []map[string]any{
			{"user_id": userU1, "sessions": "4"},
		}},
	}}
	h := newExecHandler(t, deptDB(), backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/departments", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	departments := decodeMap(t, rec)["departments"].([]any)
	if len(departments) != 3 {
		t.Fatalf("departments = %v", departments)
	}
	eng := departments[0].(map[string]any)
	if eng["department"] != "Engineering" || eng["user_count"] != float64(1) ||
		eng["agent_count"] != float64(2) || eng["utilization_pct"] != float64(100) ||
		eng["sessions_per_user"] != float64(4) {
		t.Fatalf("engineering = %v", eng)
	}
	sales := departments[1].(map[string]any)
	if sales["department"] != "Sales" || sales["utilization_pct"] != float64(0) {
		t.Fatalf("sales = %v", sales)
	}
	if departments[2].(map[string]any)["department"] != "Unassigned" {
		t.Fatalf("third = %v", departments[2])
	}
}

func TestDeptTokensTrend(t *testing.T) {
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"{days2:UInt32}", "AS tokens"}, rows: []map[string]any{
			{"user_id": userU1, "tokens": "2000"},
		}},
		{needles: []string{"AS tokens", "AS traces"}, rows: []map[string]any{
			{"user_id": userU1, "tokens": "6000", "traces": "3"},
		}},
	}}
	h := newExecHandler(t, deptDB(), backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/dept-tokens", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	items := decodeList(t, rec)
	if len(items) != 3 {
		t.Fatalf("items = %v", items)
	}
	eng := items[0].(map[string]any)
	if eng["department"] != "Engineering" || eng["tokens_used"] != float64(6000) ||
		eng["trend_pct"] != float64(200) || eng["sessions_per_user"] != float64(3) {
		t.Fatalf("engineering = %v", eng)
	}
	if items[1].(map[string]any)["trend_pct"] != float64(0) {
		t.Fatalf("idle department trend = %v", items[1])
	}
}

// ── Cost summary and ROI ─────────────────────────────────────────────────────

func TestCostSummaryUnconfigured(t *testing.T) {
	h := newExecHandler(t, &fakeDB{}, &chBackend{})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/cost-summary", "")
	body := decodeMap(t, rec)
	if body["configured"] != false {
		t.Fatalf("configured = %v", body["configured"])
	}
	if trend, ok := body["monthly_trend"].([]any); !ok || len(trend) != 0 {
		t.Fatalf("monthly_trend = %v", body["monthly_trend"])
	}
}

func configDB() *fakeDB {
	return &fakeDB{stubs: []dbStub{
		{match: "FROM exec_dashboard_config", rows: [][]any{{
			"0656308f-8bba-472e-ab77-f96a7ac69fd2", 85.5,
			map[string]any{"tasks_per_week": float64(3)}, map[string]any{},
			int64(60), nil,
		}}},
	}}
}

func TestCostSummaryConfigured(t *testing.T) {
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"AS month FROM"}, rows: []map[string]any{
			{"month": "2026-06-01"}, {"month": "2026-07-01"},
		}},
	}}
	h := newExecHandler(t, configDB(), backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/cost-summary", "")
	body := decodeMap(t, rec)
	if body["configured"] != true {
		t.Fatalf("configured = %v", body["configured"])
	}
	trend := body["monthly_trend"].([]any)
	if len(trend) != 2 || trend[0].(map[string]any)["month"] != "2026-06" {
		t.Fatalf("monthly_trend = %v", trend)
	}
}

func TestRoiProjectionsStaticShape(t *testing.T) {
	h := newExecHandler(t, &fakeDB{}, &chBackend{})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/roi-projections", "")
	body := decodeMap(t, rec)
	if body["time_to_breakeven_months"] != nil || body["roi_multiple"] != float64(0) {
		t.Fatalf("body = %v", body)
	}
	if projections, ok := body["projections"].([]any); !ok || len(projections) != 0 {
		t.Fatalf("projections = %v", body["projections"])
	}
}

// ── Config ───────────────────────────────────────────────────────────────────

func TestGetConfigAbsentIsNull(t *testing.T) {
	h := newExecHandler(t, &fakeDB{}, &chBackend{})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/config", "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "null" {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestGetConfigWireShape(t *testing.T) {
	h := newExecHandler(t, configDB(), &chBackend{})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/config", "")
	body := decodeMap(t, rec)
	if body["id"] != "0656308f-8bba-472e-ab77-f96a7ac69fd2" || body["hourly_dev_cost"] != 85.5 {
		t.Fatalf("body = %v", body)
	}
	if body["target_adoption_pct"] != float64(60) || body["target_adoption_date"] != nil {
		t.Fatalf("adoption fields: %v", body)
	}
	baselines := body["pre_ai_baselines"].(map[string]any)
	if baselines["tasks_per_week"] != float64(3) {
		t.Fatalf("baselines = %v", baselines)
	}
}

func TestPutConfigRejectsInvalidJSON(t *testing.T) {
	db := &fakeDB{}
	h := newExecHandler(t, db, &chBackend{})
	rec := serveExec(h, http.MethodPut, "/api/v1/exec/config", "not json")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"type":"json_invalid"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if len(db.execLog) != 0 {
		t.Fatalf("invalid body must not touch storage: %v", db.execLog)
	}
}

func TestPutConfigUpdatesExistingRow(t *testing.T) {
	db := configDB()
	h := newExecHandler(t, db, &chBackend{})
	rec := serveExec(h, http.MethodPut, "/api/v1/exec/config", `{"hourly_dev_cost":90}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if len(db.execLog) != 1 || !strings.Contains(db.execLog[0], "UPDATE exec_dashboard_config SET updated_at = now(), hourly_dev_cost = $1") {
		t.Fatalf("execs = %v", db.execLog)
	}
	if len(db.execArgs[0]) != 1 || db.execArgs[0][0] != 90.0 {
		t.Fatalf("args = %v", db.execArgs)
	}
	// The response re-reads the stored row.
	if decodeMap(t, rec)["hourly_dev_cost"] != 85.5 {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// insertingDB makes the config row visible after its INSERT lands, the way
// a real database would.
type insertingDB struct{ *fakeDB }

func (db *insertingDB) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tag, err := db.fakeDB.Exec(ctx, sql, args...)
	if strings.Contains(sql, "INSERT INTO exec_dashboard_config") {
		db.mu.Lock()
		db.stubs = append(db.stubs, dbStub{match: "FROM exec_dashboard_config", rows: [][]any{{
			"0656308f-8bba-472e-ab77-f96a7ac69fd2", 75.0,
			map[string]any{}, map[string]any{}, int64(100), nil,
		}}})
		db.mu.Unlock()
	}
	return tag, err
}

func TestPutConfigCreatesMissingRow(t *testing.T) {
	db := &insertingDB{fakeDB: &fakeDB{}}
	h := newExecHandler(t, db.fakeDB, &chBackend{})
	h.Store.DB = db
	rec := serveExec(h, http.MethodPut, "/api/v1/exec/config", `{"target_adoption_pct":50}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if len(db.execLog) != 2 || !strings.Contains(db.execLog[0], "INSERT INTO exec_dashboard_config") {
		t.Fatalf("execs = %v", db.execLog)
	}
	if !strings.Contains(db.execLog[1], "target_adoption_pct = $1") {
		t.Fatalf("update = %v", db.execLog[1])
	}
	if decodeMap(t, rec)["target_adoption_pct"] != float64(100) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPutConfigRejectsBadDateAsInternal(t *testing.T) {
	db := configDB()
	h := newExecHandler(t, db, &chBackend{})
	rec := serveExec(h, http.MethodPut, "/api/v1/exec/config", `{"target_adoption_date":"not-a-date"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if body := decodeMap(t, rec); body["detail"] != "Internal server error" {
		t.Fatalf("body = %v", body)
	}
}

// Regression: the singleton row vanishing between the write and the re-read
// must answer 500, never panic on a nil config.
func TestPutConfigVanishedRowIs500NotPanic(t *testing.T) {
	// The UPDATE and fallback INSERT "succeed" but no row ever becomes
	// visible, so the post-write re-read returns nothing.
	db := &fakeDB{}
	h := newExecHandler(t, db, &chBackend{})
	rec := serveExec(h, http.MethodPut, "/api/v1/exec/config", `{"hourly_dev_cost":90}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Dashboard configuration is unavailable") {
		t.Fatalf("500 detail: %s", rec.Body.String())
	}
}

// ── Strategic insights ───────────────────────────────────────────────────────

func TestStrategicInsights(t *testing.T) {
	db := deptDB()
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"LIMIT 10"}, rows: []map[string]any{
			{"model": "m-large", "sessions": "10", "avg_tokens": 6000.0},
			{"model": "m-small", "sessions": "5", "avg_tokens": "2000"},
		}},
		{needles: []string{"countIf(event_count > 5"}, rows: []map[string]any{
			{"model": "m-large", "successes": "8", "total": "10"},
		}},
		{needles: []string{"countIf(event_count > 2)"}, rows: []map[string]any{
			{"harness": "kiro", "avg_time_ms": 1500.0, "sessions": "10", "completed": "8"},
		}},
		{needles: []string{"ORDER BY value DESC"}, rows: []map[string]any{
			{"user_id": userU1, "sessions": "5", "value": "800"},
			{"user_id": userU2, "sessions": "1", "value": "200"},
		}},
		{needles: []string{"AS simple"}, rows: []map[string]any{
			{"simple": "3", "total": "10"},
		}},
		{needles: []string{"GROUP BY user_id SETTINGS"}, rows: []map[string]any{
			{"user_id": userU1, "sessions": "5"},
		}},
	}}
	h := newExecHandler(t, db, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/strategic-insights", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec)

	models := body["model_comparison"].([]any)
	if len(models) != 2 {
		t.Fatalf("models = %v", models)
	}
	large := models[0].(map[string]any)
	if large["model"] != "m-large" || large["success_rate"] != float64(80) ||
		large["best_at"] != "Most popular, proven reliability" {
		t.Fatalf("large = %v", large)
	}
	if models[1].(map[string]any)["best_at"] != "General purpose" {
		t.Fatalf("small = %v", models[1])
	}

	gaps := body["department_gaps"].([]any)
	if len(gaps) != 2 {
		t.Fatalf("gaps = %v", gaps)
	}
	sales := gaps[0].(map[string]any)
	if sales["department"] != "Sales" || sales["adoption_pct"] != float64(0) ||
		!strings.Contains(sales["opportunity"].(string), "not using AI") {
		t.Fatalf("sales gap = %v", sales)
	}
	eng := gaps[1].(map[string]any)
	if eng["department"] != "Engineering" || eng["adoption_pct"] != float64(100) ||
		eng["opportunity"] != "High adoption - focus on optimization" {
		t.Fatalf("engineering gap = %v", eng)
	}

	platforms := body["platform_comparison"].([]any)
	first := platforms[0].(map[string]any)
	if first["platform"] != "kiro" || first["success_rate"] != float64(80) {
		t.Fatalf("platform = %v", first)
	}

	if body["total_active_users"] != float64(2) || body["power_user_value_pct"] != float64(80) {
		t.Fatalf("power users: %v", body)
	}
	if body["automatable_pct"] != float64(30) {
		t.Fatalf("automatable_pct = %v", body["automatable_pct"])
	}
}

// ── Developer breakdown ──────────────────────────────────────────────────────

func TestDeveloperBreakdown(t *testing.T) {
	db := &fakeDB{stubs: []dbStub{
		{match: "count(id) FROM users", rows: [][]any{{10}}},
		{match: "SELECT id::text, name, department FROM users WHERE id = ANY", rows: [][]any{
			{userU1, "Richard", "Engineering"},
			{userU2, "Jared", nil},
		}},
		{match: "SELECT group_name, user_id::text FROM user_groups", rows: [][]any{
			{"Platform", userU2},
		}},
	}}
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"ORDER BY sessions DESC"}, rows: []map[string]any{
			{"user_id": userU1, "sessions": "6", "tokens": "9000"},
			{"user_id": userU2, "sessions": "2", "tokens": "1000"},
		}},
	}}
	h := newExecHandler(t, db, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/developer-breakdown", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec)
	if body["total_developers"] != float64(10) || body["active_developers"] != float64(2) {
		t.Fatalf("counts: %v", body)
	}
	if body["top_20_value_pct"] != float64(75) {
		t.Fatalf("top_20_value_pct = %v", body["top_20_value_pct"])
	}
	developers := body["developers"].([]any)
	if len(developers) != 2 {
		t.Fatalf("developers = %v", developers)
	}
	first := developers[0].(map[string]any)
	if first["name"] != "Richard" || first["department"] != "Engineering" ||
		first["sessions"] != float64(6) || first["percentile"] != float64(100) {
		t.Fatalf("first = %v", first)
	}
	second := developers[1].(map[string]any)
	// The group mapping wins over the profile department.
	if second["department"] != "Platform" || second["percentile"] != float64(50) {
		t.Fatalf("second = %v", second)
	}
}

func TestDeveloperBreakdownLimitValidation(t *testing.T) {
	h := newExecHandler(t, &fakeDB{}, &chBackend{})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/developer-breakdown?limit=0", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"type":"greater_than_equal"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// ── Inactivity alerts ────────────────────────────────────────────────────────

func TestInactivityAlerts(t *testing.T) {
	db := &fakeDB{stubs: []dbStub{
		{match: "SELECT id::text, name, category FROM agents WHERE id = ANY", rows: [][]any{
			{agentA, "Quiet Bot", "Coding"},
		}},
		{match: "SELECT id::text, name FROM users WHERE id = ANY", rows: [][]any{
			{userU2, "Jared"},
		}},
		{match: "SELECT group_name, user_id::text FROM user_groups", rows: [][]any{
			{"Sales", userU2},
		}},
	}}
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"agent_id, count() AS sessions", "INTERVAL 28 DAY"}, rows: []map[string]any{
			{"agent_id": agentA, "sessions": "6"},
		}},
		{needles: []string{"user_id, count() AS sessions", "INTERVAL 28 DAY"}, rows: []map[string]any{
			{"user_id": userU1, "sessions": "9"},
			{"user_id": userU2, "sessions": "7"},
		}},
		{needles: []string{"SELECT user_id FROM"}, rows: []map[string]any{
			{"user_id": userU1},
		}},
	}}
	h := newExecHandler(t, db, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/inactivity-alerts", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec)
	agents := body["inactive_agents"].([]any)
	if len(agents) != 1 {
		t.Fatalf("agents = %v", agents)
	}
	agent := agents[0].(map[string]any)
	if agent["name"] != "Quiet Bot" || agent["previous_sessions"] != float64(6) {
		t.Fatalf("agent = %v", agent)
	}
	users := body["inactive_users"].([]any)
	if len(users) != 1 {
		t.Fatalf("recently active user must not alert: %v", users)
	}
	user := users[0].(map[string]any)
	if user["name"] != "Jared" || user["department"] != "Sales" || user["previous_sessions"] != float64(7) {
		t.Fatalf("user = %v", user)
	}
}

// ── Time to value ────────────────────────────────────────────────────────────

func TestTimeToValue(t *testing.T) {
	created := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	db := &fakeDB{stubs: []dbStub{
		{match: "SELECT id::text, name, category, created_at FROM agents", rows: [][]any{
			{agentA, "Ramp Bot", "Coding", created},
		}},
	}}
	backend := &chBackend{stubs: []chStub{
		{needles: []string{"min(first_event_time)"}, rows: []map[string]any{
			{"agent_id": agentA, "total_sessions": "150"},
		}},
		{needles: []string{"WHERE rn = 100"}, rows: []map[string]any{
			{"agent_id": agentA, "start_time": "2026-01-11 00:00:00.000"},
		}},
	}}
	h := newExecHandler(t, db, backend)
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/time-to-value", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec)
	agents := body["agents"].([]any)
	if len(agents) != 1 {
		t.Fatalf("agents = %v", agents)
	}
	agent := agents[0].(map[string]any)
	if agent["name"] != "Ramp Bot" || agent["created_at"] != "2026-01-01" ||
		agent["days_to_100"] != float64(10) || agent["current_sessions"] != float64(150) {
		t.Fatalf("agent = %v", agent)
	}
	if body["avg_days_to_100"] != float64(10) {
		t.Fatalf("avg = %v", body["avg_days_to_100"])
	}
}

func TestTimeToValueNoAgents(t *testing.T) {
	h := newExecHandler(t, &fakeDB{}, &chBackend{})
	rec := serveExec(h, http.MethodGet, "/api/v1/exec/time-to-value", "")
	body := decodeMap(t, rec)
	if agents, ok := body["agents"].([]any); !ok || len(agents) != 0 {
		t.Fatalf("agents = %v", body["agents"])
	}
	if body["avg_days_to_100"] != nil {
		t.Fatalf("avg = %v", body["avg_days_to_100"])
	}
}

// ── AI insights cache ────────────────────────────────────────────────────────

// fakeRedis satisfies RedisCache with canned results.
type fakeRedis struct {
	getVal string
	getErr error
	setErr error
	setKey string
	setVal string
}

func (f *fakeRedis) Get(_ context.Context, _ string) *redis.StringCmd {
	return redis.NewStringResult(f.getVal, f.getErr)
}

func (f *fakeRedis) Set(_ context.Context, key string, value any, _ time.Duration) *redis.StatusCmd {
	f.setKey = key
	f.setVal = fmt.Sprint(value)
	if f.setErr != nil {
		return redis.NewStatusResult("", f.setErr)
	}
	return redis.NewStatusResult("OK", nil)
}

func TestAIInsightsCacheStates(t *testing.T) {
	t.Run("empty cache scaffolds", func(t *testing.T) {
		h := newExecHandler(t, &fakeDB{}, &chBackend{})
		h.Redis = &fakeRedis{getErr: redis.Nil}
		rec := serveExec(h, http.MethodGet, "/api/v1/exec/ai-insights", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		body := decodeMap(t, rec)
		if body["generated"] != false || body["generated_at"] != nil {
			t.Fatalf("body = %v", body)
		}
		insight := body["platform_insight"].(map[string]any)
		if insight["title"] != "No cached report" {
			t.Fatalf("insight = %v", insight)
		}
	})
	t.Run("redis outage is 503", func(t *testing.T) {
		h := newExecHandler(t, &fakeDB{}, &chBackend{})
		h.Redis = &fakeRedis{getErr: errors.New("redis down")}
		rec := serveExec(h, http.MethodGet, "/api/v1/exec/ai-insights", "")
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("corrupt cache is 500", func(t *testing.T) {
		h := newExecHandler(t, &fakeDB{}, &chBackend{})
		h.Redis = &fakeRedis{getVal: "{corrupt"}
		rec := serveExec(h, http.MethodGet, "/api/v1/exec/ai-insights", "")
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("cached report round-trips", func(t *testing.T) {
		h := newExecHandler(t, &fakeDB{}, &chBackend{})
		h.Redis = &fakeRedis{getVal: `{"generated":true,"quick_wins":[{"title":"w"}]}`}
		rec := serveExec(h, http.MethodGet, "/api/v1/exec/ai-insights", "")
		body := decodeMap(t, rec)
		if body["generated"] != true {
			t.Fatalf("body = %v", body)
		}
	})
}

// ── AI insight generation ────────────────────────────────────────────────────

type fakeStrategic struct {
	result    map[string]any
	err       error
	prompt    string
	model     string
	maxTokens int
}

func (f *fakeStrategic) Complete(_ context.Context, prompt, model string, maxTokens int) (map[string]any, error) {
	f.prompt, f.model, f.maxTokens = prompt, model, maxTokens
	return f.result, f.err
}

type fakeSettingsReader struct{ values map[string]string }

func (f fakeSettingsReader) String(_ context.Context, key, fallback string) string {
	if v, ok := f.values[key]; ok {
		return v
	}
	return fallback
}

func genDB() *fakeDB {
	return &fakeDB{stubs: []dbStub{
		{match: "count(*) FROM users", rows: [][]any{{10}}},
	}}
}

func TestGenerateAIInsights(t *testing.T) {
	strategic := &fakeStrategic{result: map[string]any{
		"quick_wins":       []any{map[string]any{"title": "Route small tasks down"}},
		"platform_insight": map[string]any{"title": "Kiro leads"},
	}}
	cache := &fakeRedis{}
	h := newExecHandler(t, genDB(), &chBackend{})
	h.Redis = cache
	h.Strategic = strategic
	h.Settings = fakeSettingsReader{values: map[string]string{"insights.model_synthesis": "gpt-strat"}}

	rec := serveExec(h, http.MethodPost, "/api/v1/exec/ai-insights", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec)
	if body["generated"] != true || body["generated_at"] == nil {
		t.Fatalf("body = %v", body)
	}
	wins := body["quick_wins"].([]any)
	if len(wins) != 1 || wins[0].(map[string]any)["title"] != "Route small tasks down" {
		t.Fatalf("quick_wins = %v", wins)
	}
	// Sections missing from the model response become empty containers.
	if gaps, ok := body["adoption_gaps"].([]any); !ok || len(gaps) != 0 {
		t.Fatalf("adoption_gaps = %v", body["adoption_gaps"])
	}
	if strategic.model != "gpt-strat" || strategic.maxTokens != 4096 {
		t.Fatalf("generation call: model=%q maxTokens=%d", strategic.model, strategic.maxTokens)
	}
	if !strings.Contains(strategic.prompt, "## Adoption") || !strings.Contains(strategic.prompt, `"total_users": 10`) {
		t.Fatalf("prompt missing telemetry:\n%s", strategic.prompt)
	}
	if cache.setKey != "exec.ai_insights" || cache.setVal != rec.Body.String() {
		t.Fatalf("cache write: key=%q", cache.setKey)
	}
}

func TestGenerateAIInsightsFallbackModelKey(t *testing.T) {
	strategic := &fakeStrategic{result: map[string]any{"platform_insight": map[string]any{"title": "x"}}}
	h := newExecHandler(t, genDB(), &chBackend{})
	h.Redis = &fakeRedis{}
	h.Strategic = strategic
	h.Settings = fakeSettingsReader{values: map[string]string{"insights.model_sections": "gpt-sections"}}
	rec := serveExec(h, http.MethodPost, "/api/v1/exec/ai-insights", "")
	if rec.Code != http.StatusOK || strategic.model != "gpt-sections" {
		t.Fatalf("status = %d model = %q", rec.Code, strategic.model)
	}
}

func TestGenerateAIInsightsUnavailable(t *testing.T) {
	t.Run("no model configured", func(t *testing.T) {
		h := newExecHandler(t, genDB(), &chBackend{})
		h.Redis = &fakeRedis{}
		h.Settings = fakeSettingsReader{values: map[string]string{}}
		rec := serveExec(h, http.MethodPost, "/api/v1/exec/ai-insights", "")
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("generation failure", func(t *testing.T) {
		h := newExecHandler(t, genDB(), &chBackend{})
		h.Redis = &fakeRedis{}
		h.Strategic = &fakeStrategic{err: errors.New("llm down")}
		h.Settings = fakeSettingsReader{values: map[string]string{"insights.model_synthesis": "m"}}
		rec := serveExec(h, http.MethodPost, "/api/v1/exec/ai-insights", "")
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("cache write failure", func(t *testing.T) {
		h := newExecHandler(t, genDB(), &chBackend{})
		h.Redis = &fakeRedis{setErr: errors.New("redis down")}
		h.Strategic = &fakeStrategic{result: map[string]any{"platform_insight": map[string]any{"title": "x"}}}
		h.Settings = fakeSettingsReader{values: map[string]string{"insights.model_synthesis": "m"}}
		rec := serveExec(h, http.MethodPost, "/api/v1/exec/ai-insights", "")
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("db failure is sanitized 500", func(t *testing.T) {
		h := newExecHandler(t, &fakeDB{err: errors.New("pg down")}, &chBackend{})
		h.Redis = &fakeRedis{}
		rec := serveExec(h, http.MethodPost, "/api/v1/exec/ai-insights", "")
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
		}
		if body := decodeMap(t, rec); body["detail"] != "Internal server error" {
			t.Fatalf("body = %v", body)
		}
	})
}
