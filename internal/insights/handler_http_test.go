// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insights

import (
	"context"
	"encoding/json"
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

	"github.com/garudex-labs/caracal/internal/agents"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// ── pgx fake: Scan-aware and Values-aware (agents.LoadWith collects maps) ───

type insRows struct {
	fields []string
	rows   [][]any
	err    error
	idx    int
}

func (r *insRows) Close()     {}
func (r *insRows) Err() error { return r.err }
func (r *insRows) CommandTag() pgconn.CommandTag {
	return pgconn.CommandTag{}
}

func (r *insRows) FieldDescriptions() []pgconn.FieldDescription {
	out := make([]pgconn.FieldDescription, len(r.fields))
	for i, f := range r.fields {
		out[i] = pgconn.FieldDescription{Name: f}
	}
	return out
}

func (r *insRows) Next() bool             { r.idx++; return r.err == nil && r.idx <= len(r.rows) }
func (r *insRows) Values() ([]any, error) { return r.rows[r.idx-1], nil }
func (r *insRows) RawValues() [][]byte    { return nil }
func (r *insRows) Conn() *pgx.Conn        { return nil }

func (r *insRows) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if r.idx == 0 || r.idx > len(r.rows) {
		return pgx.ErrNoRows
	}
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		if err := insAssign(d, row[i]); err != nil {
			return fmt.Errorf("column %d: %w", i, err)
		}
	}
	return nil
}

func insAssign(dest, value any) error {
	switch d := dest.(type) {
	case *any:
		*d = value
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

type insRow struct{ rows *insRows }

func (r insRow) Scan(dest ...any) error {
	if r.rows.err != nil {
		return r.rows.err
	}
	if !r.rows.Next() {
		return pgx.ErrNoRows
	}
	return r.rows.Scan(dest...)
}

// insStub answers queries whose SQL contains match; a non-empty arg further
// requires one query argument to render exactly to it.
type insStub struct {
	match string
	arg   string
	rows  *insRows
}

type insExec struct {
	match string
	tag   pgconn.CommandTag
}

type insDB struct {
	stubs   []insStub
	execs   []insExec
	log     []string
	execLog []string
}

func (db *insDB) route(sql string, args []any) *insRows {
	db.log = append(db.log, sql)
	for _, s := range db.stubs {
		if !strings.Contains(sql, s.match) {
			continue
		}
		if s.arg != "" {
			found := false
			for _, a := range args {
				if fmt.Sprint(a) == s.arg {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		copyRows := *s.rows
		copyRows.idx = 0
		return &copyRows
	}
	return &insRows{}
}

func (db *insDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	return db.route(sql, args), nil
}

func (db *insDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	return insRow{db.route(sql, args)}
}

func (db *insDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	db.execLog = append(db.execLog, sql)
	for _, e := range db.execs {
		if strings.Contains(sql, e.match) {
			return e.tag, nil
		}
	}
	return pgconn.NewCommandTag("DELETE 0"), nil
}

func (db *insDB) Begin(_ context.Context) (pgx.Tx, error) {
	return nil, errors.New("insDB: transactions not supported")
}

// chStub routes analytics queries by SQL substring.
type chStub struct {
	match string
	rows  []map[string]any
	err   error
}

type insCH struct{ stubs []chStub }

func (c *insCH) QueryJSON(_ context.Context, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
	for _, s := range c.stubs {
		if strings.Contains(sql, s.match) {
			return s.rows, s.err
		}
	}
	return nil, errors.New("insCH: no stub")
}

// ── fixtures ────────────────────────────────────────────────────────────────

var (
	insViewerID = uuid.MustParse("22222222-2222-2222-2222-222222222222")
	insOtherID  = uuid.MustParse("33333333-3333-3333-3333-333333333333")
	insAgentA   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	insAgentB   = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	insReportID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	insTime     = time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
)

var agentFields = []string{"id", "name", "created_by", "co_authors", "status", "row_visible"}

// agentStub answers the agents.LoadWith detail query for one agent id.
func agentStub(agentID string, createdBy uuid.UUID) insStub {
	return insStub{match: "FROM agents a", arg: agentID, rows: &insRows{
		fields: agentFields,
		rows:   [][]any{{agentID, "Helper", createdBy.String(), nil, "approved", true}},
	}}
}

// reportRowValues matches the reportColumns scan order.
func reportRowValues(agentID string) []any {
	return []any{
		insReportID, agentID, nil, "1.2.0", "all", nil, nil, insViewerID.String(),
		"completed", insTime, insTime.Add(time.Hour),
		map[string]any{"score": 1}, "narrative text", 12, "gpt-test", nil,
		insTime, nil, insTime, nil,
		nil, 2, nil, nil,
		"done", 3, 4, 75, nil, nil,
	}
}

// listRowValues matches the listColumns scan order.
func listRowValues(agentID string) []any {
	return []any{
		insReportID, agentID, nil, "1.2.0", "all", "completed",
		insTime, insTime.Add(time.Hour), 12, insTime, nil,
		"done", 3, 4, 75, nil, nil,
	}
}

func serveInsights(t *testing.T, h *Handler, method, target, role string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	ctx := httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: insViewerID, Role: role,
	})
	req = req.WithContext(tenancy.ContextWithProjectID(ctx, "project-1"))
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func newInsightsHandler(db *insDB, ch *insCH) *Handler {
	if ch == nil {
		ch = &insCH{}
	}
	return &Handler{Store: &Store{DB: db, CH: ch}, Agents: &agents.Store{DB: db}}
}

// ── report reads ────────────────────────────────────────────────────────────

func TestListReportsForOwner(t *testing.T) {
	db := &insDB{stubs: []insStub{
		agentStub(insAgentA, insViewerID),
		{match: "ORDER BY created_at DESC LIMIT 20", rows: &insRows{rows: [][]any{listRowValues(insAgentA)}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodGet,
		"/api/v1/insights/agents/"+insAgentA+"/reports", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil || len(items) != 1 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	item := items[0]
	if item["id"] != insReportID || item["status"] != "completed" || item["sessions_analyzed"] != float64(12) {
		t.Errorf("list wire: %v", item)
	}
	if item["period_start"] != "2026-08-30T08:00:00Z" || item["completed_at"] != nil {
		t.Errorf("list wire times: %v", item)
	}
	if item["progress_percent"] != float64(75) || item["progress_phase"] != "done" {
		t.Errorf("list wire progress: %v", item)
	}
}

func TestListReportsDeniedForNonOwners(t *testing.T) {
	db := &insDB{stubs: []insStub{agentStub(insAgentA, insOtherID)}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodGet,
		"/api/v1/insights/agents/"+insAgentA+"/reports", "user")
	if rec.Code != http.StatusForbidden ||
		!strings.Contains(rec.Body.String(), "Insufficient permissions for this agent") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestListReportsDeniedForNonOwnerOperator(t *testing.T) {
	db := &insDB{stubs: []insStub{
		agentStub(insAgentA, insOtherID),
		{match: "ORDER BY created_at DESC LIMIT 20", rows: &insRows{rows: [][]any{}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodGet,
		"/api/v1/insights/agents/"+insAgentA+"/reports", "operator")
	if rec.Code != http.StatusForbidden {
		t.Errorf("operator must hold no implicit authority over tenant agents: %d %s", rec.Code, rec.Body.String())
	}
}

func TestListReportsUnknownAgentIs404(t *testing.T) {
	rec := serveInsights(t, newInsightsHandler(&insDB{}, nil), http.MethodGet,
		"/api/v1/insights/agents/"+insAgentA+"/reports", "user")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Agent not found") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestGetReportDetail(t *testing.T) {
	db := &insDB{stubs: []insStub{
		agentStub(insAgentA, insViewerID),
		{match: "FROM insight_reports WHERE id = $1", rows: &insRows{rows: [][]any{reportRowValues(insAgentA)}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodGet,
		"/api/v1/insights/reports/"+insReportID, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["id"] != insReportID || out["agent_version"] != "1.2.0" || out["narrative"] != "narrative text" {
		t.Errorf("detail wire: %v", out)
	}
	metrics, _ := out["metrics"].(map[string]any)
	if metrics["score"] != float64(1) || out["report_version"] != float64(2) {
		t.Errorf("detail payloads: %v", out)
	}
	if out["llm_model_used"] != "gpt-test" || out["error_message"] != nil || out["applied_at"] != nil {
		t.Errorf("detail nullables: %v", out)
	}
}

func TestGetReportMissingIs404(t *testing.T) {
	rec := serveInsights(t, newInsightsHandler(&insDB{}, nil), http.MethodGet,
		"/api/v1/insights/reports/"+insReportID, "user")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Report not found") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestGetReportHiddenAgentAnswersLikeMissingReport(t *testing.T) {
	// The report exists but its agent does not resolve for the caller: the
	// denial must read as a missing report, not a permission hint.
	db := &insDB{stubs: []insStub{
		{match: "FROM insight_reports WHERE id = $1", rows: &insRows{rows: [][]any{reportRowValues(insAgentA)}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodGet,
		"/api/v1/insights/reports/"+insReportID, "user")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Report not found") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestGetReportDeniedForNonOwners(t *testing.T) {
	db := &insDB{stubs: []insStub{
		agentStub(insAgentA, insOtherID),
		{match: "FROM insight_reports WHERE id = $1", rows: &insRows{rows: [][]any{reportRowValues(insAgentA)}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodGet,
		"/api/v1/insights/reports/"+insReportID, "user")
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAgentReportMustBelongToAgent(t *testing.T) {
	db := &insDB{stubs: []insStub{
		agentStub(insAgentA, insViewerID),
		agentStub(insAgentB, insViewerID),
		{match: "FROM insight_reports WHERE id = $1", rows: &insRows{rows: [][]any{reportRowValues(insAgentB)}}},
	}}
	h := newInsightsHandler(db, nil)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/agents/"+insAgentA+"/insights/reports/"+insReportID, nil)
	ctx := httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: insViewerID, Role: "user",
	})
	req = req.WithContext(tenancy.ContextWithProjectID(ctx, "project-1"))
	rec := httptest.NewRecorder()
	h.AgentRoutes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Report not found for agent") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

// ── deletions ───────────────────────────────────────────────────────────────

func TestDeleteReportDeniedForNonOwners(t *testing.T) {
	db := &insDB{stubs: []insStub{
		agentStub(insAgentA, insOtherID),
		{match: "FROM insight_reports WHERE id = $1", rows: &insRows{rows: [][]any{reportRowValues(insAgentA)}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodDelete,
		"/api/v1/insights/reports/"+insReportID, "user")
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestDeleteReportRemovesRow(t *testing.T) {
	db := &insDB{stubs: []insStub{
		agentStub(insAgentA, insViewerID),
		{match: "FROM insight_reports WHERE id = $1", rows: &insRows{rows: [][]any{reportRowValues(insAgentA)}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodDelete,
		"/api/v1/insights/reports/"+insReportID, "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["deleted"] != true || out["report_id"] != insReportID {
		t.Errorf("delete wire: %v", out)
	}
	deleted := false
	for _, sql := range db.execLog {
		if strings.Contains(sql, "DELETE FROM insight_reports WHERE id") {
			deleted = true
		}
	}
	if !deleted {
		t.Errorf("no DELETE issued: %v", db.execLog)
	}
}

func TestClearAgentReportsCounts(t *testing.T) {
	db := &insDB{
		stubs: []insStub{agentStub(insAgentA, insViewerID)},
		execs: []insExec{
			{match: "DELETE FROM insight_reports", tag: pgconn.NewCommandTag("DELETE 3")},
			{match: "insight_session_facets", tag: pgconn.NewCommandTag("DELETE 2")},
			{match: "insight_meta_cache", tag: pgconn.NewCommandTag("DELETE 1")},
		},
	}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodDelete,
		"/api/v1/insights/agents/"+insAgentA+"/reports", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["deleted_reports"] != float64(3) || out["deleted_facets"] != float64(2) || out["deleted_cache"] != float64(1) {
		t.Errorf("counts wire: %v", out)
	}
}

// ── session count ───────────────────────────────────────────────────────────

func approvedVersionStub() insStub {
	return insStub{match: "FROM agent_versions", rows: &insRows{rows: [][]any{
		{"dddddddd-dddd-4ddd-8ddd-dddddddddddd", "1.2.0"},
	}}}
}

func TestSessionCountNoApprovedVersion(t *testing.T) {
	db := &insDB{stubs: []insStub{agentStub(insAgentA, insViewerID)}}
	rec := serveInsights(t, newInsightsHandler(db, nil), http.MethodGet,
		"/api/v1/insights/agents/"+insAgentA+"/session-count", "user")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "No approved agent version found") {
		t.Errorf("latest: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &insDB{stubs: []insStub{agentStub(insAgentA, insViewerID)}}
	rec = serveInsights(t, newInsightsHandler(db, nil), http.MethodGet,
		"/api/v1/insights/agents/"+insAgentA+"/session-count?agent_version=2.0.0", "user")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Approved version '2.0.0' not found") {
		t.Errorf("requested: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSessionCountFromAggregates(t *testing.T) {
	db := &insDB{stubs: []insStub{agentStub(insAgentA, insViewerID), approvedVersionStub()}}
	ch := &insCH{stubs: []chStub{
		{match: "session_stats_agg", rows: []map[string]any{{"cnt": "7"}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, ch), http.MethodGet,
		"/api/v1/insights/agents/"+insAgentA+"/session-count", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["session_count"] != float64(7) || out["agent_version"] != "1.2.0" {
		t.Errorf("count wire: %v", out)
	}
}

func TestSessionCountFallsBackToRawEvents(t *testing.T) {
	db := &insDB{stubs: []insStub{agentStub(insAgentA, insViewerID), approvedVersionStub()}}
	ch := &insCH{stubs: []chStub{
		{match: "session_stats_agg", err: errors.New("aggregate table missing")},
		{match: "session_events", rows: []map[string]any{{"cnt": float64(5)}}},
	}}
	rec := serveInsights(t, newInsightsHandler(db, ch), http.MethodGet,
		"/api/v1/insights/agents/"+insAgentA+"/session-count", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["session_count"] != float64(5) {
		t.Errorf("fallback count: %v", out)
	}
}

// ── store edges ─────────────────────────────────────────────────────────────

func TestSessionCountZeroWhenTelemetryDown(t *testing.T) {
	s := &Store{DB: &insDB{}, CH: &insCH{}}
	if got := s.SessionCount(context.Background(), insAgentA, "Helper",
		insTime, insTime.Add(time.Hour), "1.2.0"); got != 0 {
		t.Errorf("count = %d, want 0", got)
	}
}

func TestGetReportMalformedIDIsAbsent(t *testing.T) {
	db := &insDB{stubs: []insStub{
		{match: "FROM insight_reports WHERE id = $1",
			rows: &insRows{err: &pgconn.PgError{Code: "22P02"}}},
	}}
	rep, err := (&Store{DB: db}).GetReport(context.Background(), "not-a-uuid")
	if rep != nil || err != nil {
		t.Errorf("rep = %v, err = %v; want nil, nil", rep, err)
	}
}

func TestApprovedVersionScopesRequested(t *testing.T) {
	db := &insDB{stubs: []insStub{approvedVersionStub()}}
	s := &Store{DB: db}
	_, version, err := s.ApprovedVersion(context.Background(), insAgentA, "1.2.0")
	if err != nil || version != "1.2.0" {
		t.Fatalf("version = %q, err = %v", version, err)
	}
	if !strings.Contains(db.log[0], "AND version = $2") {
		t.Errorf("requested version missing from SQL:\n%s", db.log[0])
	}
	db = &insDB{stubs: []insStub{approvedVersionStub()}}
	_, _, _ = (&Store{DB: db}).ApprovedVersion(context.Background(), insAgentA, "")
	if !strings.Contains(db.log[0], "ORDER BY released_at DESC") {
		t.Errorf("latest ordering missing from SQL:\n%s", db.log[0])
	}
}
