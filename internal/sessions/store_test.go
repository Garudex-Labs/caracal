// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// chRoute answers statements containing the match fragment.
type chRoute struct {
	match string
	rows  []map[string]any
	fail  bool
}

// chBackend fakes the analytics store, recording every statement and its
// bound parameters.
type chBackend struct {
	routes []chRoute
	stmts  []string
	params []url.Values
}

func (b *chBackend) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	sql := string(body)
	b.stmts = append(b.stmts, sql)
	b.params = append(b.params, r.URL.Query())
	for _, route := range b.routes {
		if strings.Contains(sql, route.match) {
			if route.fail {
				http.Error(w, "boom", http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": route.rows})
			return
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{}})
}

func newCHStore(t *testing.T, backend *chBackend) *CHStore {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(backend.handler))
	t.Cleanup(server.Close)
	client, err := clickhouse.New(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return &CHStore{Client: client}
}

func TestCHListSessionsBindsEveryFilterAsParameter(t *testing.T) {
	backend := &chBackend{routes: []chRoute{
		{match: "session_stats_agg", rows: []map[string]any{{"session_id": "s-1"}}},
	}}
	store := newCHStore(t, backend)

	rows, err := store.ListSessions(context.Background(), ListFilter{
		Platform:  "kiro",
		UserIDs:   []string{"u-1", "u-2"},
		Days:      7,
		OwnerOnly: true,
		OwnerID:   "owner-1",
		Limit:     50,
		Offset:    10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["session_id"] != "s-1" {
		t.Fatalf("rows = %v", rows)
	}
	sql := backend.stmts[0]
	for _, want := range []string{
		"user_id = {uid:String}",
		"last_event_time > now() - INTERVAL 7 DAY",
		"harness = {platform:String}",
		"user_id IN ({user_0:String}, {user_1:String})",
		"ORDER BY last_event_time DESC",
		"LIMIT 50 OFFSET 10 FORMAT JSON",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("sql missing %q: %s", want, sql)
		}
	}
	qs := backend.params[0]
	for key, want := range map[string]string{
		"param_uid": "owner-1", "param_platform": "kiro",
		"param_user_0": "u-1", "param_user_1": "u-2",
	} {
		if got := qs.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestCHListSessionsUnscopedOmitsFilters(t *testing.T) {
	backend := &chBackend{}
	store := newCHStore(t, backend)
	if _, err := store.ListSessions(context.Background(), ListFilter{Limit: 25}); err != nil {
		t.Fatal(err)
	}
	sql := backend.stmts[0]
	for _, absent := range []string{"{uid:String}", " DAY", "{platform:String}", "user_id IN"} {
		if strings.Contains(sql, absent) {
			t.Errorf("sql should not contain %q: %s", absent, sql)
		}
	}
}

func TestCHQuerySessionsPageAndAggregateShareOneFilter(t *testing.T) {
	backend := &chBackend{routes: []chRoute{
		{match: "quantile(0.95)", rows: []map[string]any{{
			"total": "3", "p95_duration_s": 120.5, "p95_total_tokens": "9000.5",
		}}},
		{match: "ORDER BY", rows: []map[string]any{{"session_id": "s-1"}}},
	}}
	store := newCHStore(t, backend)

	page, err := store.QuerySessions(context.Background(), QueryFilter{
		Search:       "deploy",
		Platform:     "kiro",
		Model:        "sonnet",
		AgentID:      "a-1",
		UserIDs:      []string{"u-1"},
		Days:         30,
		Status:       "active",
		MinDurationS: 45,
		MinTokens:    1000,
		OwnerOnly:    true,
		OwnerID:      "owner-1",
		Sort:         "tokens",
		Limit:        25,
		Offset:       50,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0]["session_id"] != "s-1" {
		t.Fatalf("items = %v", page.Items)
	}
	if page.Total != 3 || page.P95DurationS != 120.5 || page.P95Tokens != 9000.5 {
		t.Fatalf("aggregate = %+v", page)
	}
	if len(backend.stmts) != 2 {
		t.Fatalf("statements = %d, want page + aggregate", len(backend.stmts))
	}
	pageSQL := backend.stmts[0]
	for _, want := range []string{
		"positionCaseInsensitive(session_id, {q:String}) > 0",
		"positionCaseInsensitive(model, {model:String}) > 0",
		"agent_id = {agent:String}",
		"user_id = {uid:String}",
		"last_event_time > now() - INTERVAL 30 DAY",
		"is_active = 1",
		"duration_s >= 45",
		"total_tokens >= 1000",
		"ORDER BY total_tokens DESC, session_id ASC",
		"LIMIT 25 OFFSET 50 FORMAT JSON",
	} {
		if !strings.Contains(pageSQL, want) {
			t.Errorf("page sql missing %q: %s", want, pageSQL)
		}
	}
	aggSQL := backend.stmts[1]
	if !strings.Contains(aggSQL, "count() AS total") || !strings.Contains(aggSQL, "is_active = 1") {
		t.Fatalf("aggregate sql: %s", aggSQL)
	}
	for key, want := range map[string]string{
		"param_q": "deploy", "param_model": "sonnet", "param_agent": "a-1",
		"param_uid": "owner-1", "param_user_0": "u-1", "param_platform": "kiro",
	} {
		if got := backend.params[0].Get(key); got != want {
			t.Errorf("page %s = %q, want %q", key, got, want)
		}
		if got := backend.params[1].Get(key); got != want {
			t.Errorf("aggregate %s = %q, want %q", key, got, want)
		}
	}
}

func TestCHQuerySessionsDefaultsUnknownSortAndCompletedStatus(t *testing.T) {
	backend := &chBackend{}
	store := newCHStore(t, backend)
	if _, err := store.QuerySessions(context.Background(), QueryFilter{
		Status: "completed", Sort: "bogus", Limit: 10,
	}); err != nil {
		t.Fatal(err)
	}
	sql := backend.stmts[0]
	if !strings.Contains(sql, "ORDER BY last_event_time DESC, session_id ASC") {
		t.Fatalf("unknown sort should fall back to recent: %s", sql)
	}
	if !strings.Contains(sql, "is_active = 0") {
		t.Fatalf("completed status filter missing: %s", sql)
	}
}

func TestCHQuerySessionsSurfacesStoreFailures(t *testing.T) {
	t.Run("page query fails", func(t *testing.T) {
		backend := &chBackend{routes: []chRoute{{match: "ORDER BY", fail: true}}}
		store := newCHStore(t, backend)
		if _, err := store.QuerySessions(context.Background(), QueryFilter{Limit: 10}); err == nil {
			t.Fatal("want error when the page query fails")
		}
	})
	t.Run("aggregate query fails", func(t *testing.T) {
		backend := &chBackend{routes: []chRoute{{match: "quantile(0.95)", fail: true}}}
		store := newCHStore(t, backend)
		if _, err := store.QuerySessions(context.Background(), QueryFilter{Limit: 10}); err == nil {
			t.Fatal("want error when the aggregate query fails")
		}
	})
}

func TestJSONCountCoercions(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  int
	}{
		{"float", float64(7), 7},
		{"quoted int64", "42", 42},
		{"garbage string", "many", 0},
		{"nil", nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := jsonCount(tc.value); got != tc.want {
				t.Fatalf("jsonCount(%v) = %d, want %d", tc.value, got, tc.want)
			}
		})
	}
}

func TestJSONFloatCoercions(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  float64
	}{
		{"float", 1.5, 1.5},
		{"quoted float", "2.25", 2.25},
		{"garbage string", "nope", 0},
		{"nil", nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := jsonFloat(tc.value); got != tc.want {
				t.Fatalf("jsonFloat(%v) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestCHSummaryScopesToUser(t *testing.T) {
	backend := &chBackend{routes: []chRoute{
		{match: "today_sessions", rows: []map[string]any{{"total": "5", "today_sessions": "2"}}},
	}}
	store := newCHStore(t, backend)

	row, err := store.Summary(context.Background(), "default", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if row["total"] != "5" {
		t.Fatalf("row = %v", row)
	}
	if !strings.Contains(backend.stmts[0], "user_id = {uid:String}") {
		t.Fatalf("scoped sql: %s", backend.stmts[0])
	}
	if got := backend.params[0].Get("param_uid"); got != "u-1" {
		t.Fatalf("param_uid = %q", got)
	}
	if got := backend.params[0].Get("param_pid"); got != "default" {
		t.Fatalf("param_pid = %q", got)
	}

	if _, err := store.Summary(context.Background(), "default", ""); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(backend.stmts[1], "{uid:String}") {
		t.Fatalf("unscoped sql must not filter by user: %s", backend.stmts[1])
	}
}

func TestCHSummaryEmptyResultIsNotAnError(t *testing.T) {
	store := newCHStore(t, &chBackend{})
	row, err := store.Summary(context.Background(), "default", "")
	if err != nil {
		t.Fatal(err)
	}
	if row == nil || len(row) != 0 {
		t.Fatalf("row = %v, want empty map", row)
	}
}

func TestCHStatsAggregatesAcrossSessions(t *testing.T) {
	backend := &chBackend{routes: []chRoute{
		{match: "total_sessions", rows: []map[string]any{{"total_sessions": "9"}}},
	}}
	store := newCHStore(t, backend)
	row, err := store.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if row["total_sessions"] != "9" {
		t.Fatalf("row = %v", row)
	}
	if !strings.Contains(backend.stmts[0], "sum(prompt_count) AS total_prompts") {
		t.Fatalf("sql: %s", backend.stmts[0])
	}
}

func TestCHSessionIdentityScoping(t *testing.T) {
	backend := &chBackend{routes: []chRoute{
		{match: "session_events", rows: []map[string]any{
			{"project_id": "default", "user_id": "u-1", "harness": "kiro"},
		}},
	}}
	store := newCHStore(t, backend)

	row, err := store.SessionIdentity(context.Background(), "s-1", "default", "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if row["harness"] != "kiro" {
		t.Fatalf("row = %v", row)
	}
	if !strings.Contains(backend.stmts[0], "AND user_id = {uid:String}") {
		t.Fatalf("scoped sql: %s", backend.stmts[0])
	}
	if got := backend.params[0].Get("param_sid"); got != "s-1" {
		t.Fatalf("param_sid = %q", got)
	}
	if got := backend.params[0].Get("param_pid"); got != "default" {
		t.Fatalf("param_pid = %q", got)
	}

	if _, err := store.SessionIdentity(context.Background(), "s-1", "default", ""); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(backend.stmts[1], "{uid:String}") {
		t.Fatalf("admin scope must not filter by user: %s", backend.stmts[1])
	}
}

func TestCHSessionIdentityInvisibleSessionIsNil(t *testing.T) {
	store := newCHStore(t, &chBackend{})
	row, err := store.SessionIdentity(context.Background(), "ghost", "default", "u-1")
	if err != nil || row != nil {
		t.Fatalf("row = %v, err = %v; want nil, nil", row, err)
	}
}

func TestCHSessionRowsPinsIdentityAndOffset(t *testing.T) {
	backend := &chBackend{}
	store := newCHStore(t, backend)
	id := Identity{SessionID: "s-1", ProjectID: "default", UserID: "u-1", Harness: "kiro"}

	if _, err := store.SessionRows(context.Background(), id, nil); err != nil {
		t.Fatal(err)
	}
	sql := backend.stmts[0]
	for _, want := range []string{
		"session_id = {sid:String}",
		"project_id = {pid:String} AND user_id = {uid:String} AND harness = {harness:String}",
		"rendered = 1",
		"ORDER BY line_offset ASC",
		"do_not_merge_across_partitions_select_final = 1",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("sql missing %q: %s", want, sql)
		}
	}
	if strings.Contains(sql, "line_offset > {offset:UInt32}") {
		t.Fatalf("nil afterOffset must not filter by offset: %s", sql)
	}
	for key, want := range map[string]string{
		"param_sid": "s-1", "param_pid": "default", "param_uid": "u-1", "param_harness": "kiro",
	} {
		if got := backend.params[0].Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}

	offset := int64(42)
	if _, err := store.SessionRows(context.Background(), id, &offset); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(backend.stmts[1], "line_offset > {offset:UInt32}") {
		t.Fatalf("offset filter missing: %s", backend.stmts[1])
	}
	if got := backend.params[1].Get("param_offset"); got != "42" {
		t.Fatalf("param_offset = %q", got)
	}
}

func TestCHSubagentRowsGroupByChildSession(t *testing.T) {
	backend := &chBackend{}
	store := newCHStore(t, backend)
	id := Identity{SessionID: "s-1", ProjectID: "default", UserID: "u-1", Harness: "kiro"}

	offset := int64(7)
	if _, err := store.SubagentRows(context.Background(), id, &offset); err != nil {
		t.Fatal(err)
	}
	sql := backend.stmts[0]
	for _, want := range []string{
		"parent_session_id = {sid:String}",
		"line_offset > {offset:UInt32}",
		"ORDER BY session_id, line_offset ASC",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("sql missing %q: %s", want, sql)
		}
	}
	if got := backend.params[0].Get("param_offset"); got != "7" {
		t.Fatalf("param_offset = %q", got)
	}
}

func TestCHOwnsSession(t *testing.T) {
	backend := &chBackend{routes: []chRoute{
		{match: "SELECT 1 FROM session_events", rows: []map[string]any{{"1": float64(1)}}},
	}}
	store := newCHStore(t, backend)
	owns, err := store.OwnsSession(context.Background(), "s-1", "default", "u-1")
	if err != nil || !owns {
		t.Fatalf("owns = %v, err = %v", owns, err)
	}
	if got := backend.params[0].Get("param_uid"); got != "u-1" {
		t.Fatalf("param_uid = %q", got)
	}
	if got := backend.params[0].Get("param_pid"); got != "default" {
		t.Fatalf("param_pid = %q", got)
	}

	empty := newCHStore(t, &chBackend{})
	owns, err = empty.OwnsSession(context.Background(), "s-1", "default", "u-1")
	if err != nil || owns {
		t.Fatalf("no rows should mean not owned; owns = %v, err = %v", owns, err)
	}

	failing := newCHStore(t, &chBackend{routes: []chRoute{{match: "SELECT 1", fail: true}}})
	owns, err = failing.OwnsSession(context.Background(), "s-1", "default", "u-1")
	if err == nil || owns {
		t.Fatalf("store failure must not grant ownership; owns = %v, err = %v", owns, err)
	}
}
