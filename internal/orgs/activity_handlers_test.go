// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

type orgActivityCH struct {
	sql      string
	settings clickhouse.Settings
	rows     []map[string]any
}

func (ch *orgActivityCH) QueryJSON(_ context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error) {
	ch.sql = sql
	ch.settings = settings
	return ch.rows, nil
}

func serveOrgActivity(t *testing.T, db *fakeDB, ch *orgActivityCH, target string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}, Settings: fakeSetting{}, CH: ch}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{UserID: callerID, Role: "user"})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func orgActivityDB(role string) *fakeDB {
	return &fakeDB{stubs: []stub{{match: "WHERE o.slug = $1", rows: &fakeRows{rows: [][]any{
		orgRowValues("acme", "Acme", role),
	}}}}}
}

// chActivityRows fabricates n ClickHouse rows ordered like a DESC page: index 0
// is newest, so the last kept row (index pageSize-1) is the next cursor anchor.
func chActivityRows(n int) []map[string]any {
	rows := make([]map[string]any, n)
	for i := range rows {
		rows[i] = map[string]any{
			"event_id":    fmt.Sprintf("e0000000-0000-4000-8000-%012d", i),
			"timestamp":   fmt.Sprintf("2026-08-30 12:%02d:00.000", i%60),
			"duration_ms": float64(i),
			"status_code": float64(200 + i%5),
		}
	}
	return rows
}

type activityResponse struct {
	Events     []map[string]any `json:"events"`
	NextCursor *string          `json:"next_cursor"`
	HasMore    bool             `json:"has_more"`
	PageSize   int              `json:"page_size"`
}

func decodeActivityResponse(t *testing.T, rec *httptest.ResponseRecorder) activityResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp activityResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v (%s)", err, rec.Body.String())
	}
	return resp
}

func TestOrgSecurityEventsRequireCapabilityAndScopeQuery(t *testing.T) {
	ch := &orgActivityCH{rows: chActivityRows(3)}
	rec := serveOrgActivity(t, orgActivityDB("admin"), ch,
		"/api/v1/orgs/acme/security-events?event_type=org.created&severity=info&outcome=success&actor=dev@x.io&target_type=organization&target_id="+orgID.String()+"&source_ip=127.0.0.1&category=membership&target=core&start_date=2026-08-01&end_date=2026-08-31T23:59:59&q=membership&dir=asc")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{
		"target_type = 'organization'", "target_id = {org_id:String}",
		"event_type = {f_event_type:String}", "severity = {f_severity:String}",
		"outcome = {f_outcome:String}", "actor_email = {f_actor_email:String}",
		"target_type = {f_target_type:String}", "target_id = {f_target_id:String}",
		"source_ip = {f_source_ip:String}",
		"event_type IN ('org.membership.changed', 'org.project.membership.changed')",
		"timestamp >= {start:String}", "timestamp <= {end:String}",
		"lowerUTF8(concat(target_type, ' ', target_id, ' ', detail)) LIKE {target:String}",
		"lowerUTF8(concat(event_type, ' ', severity, ' ', actor_email, ' ', actor_role, ' ', target_type, ' ', target_id, ' ', outcome, ' ', source_ip, ' ', user_agent, ' ', detail)) LIKE {search:String}",
		"ORDER BY timestamp ASC, event_id ASC LIMIT 21",
	} {
		if !strings.Contains(ch.sql, want) {
			t.Errorf("security SQL missing %q: %s", want, ch.sql)
		}
	}
	if strings.Contains(ch.sql, "SELECT *") {
		t.Errorf("security query still selects every column: %s", ch.sql)
	}
	if ch.settings["param_org_id"] != orgID.String() || ch.settings["param_f_actor_email"] != "dev@x.io" ||
		ch.settings["param_f_target_id"] != orgID.String() || ch.settings["param_target"] != "%core%" ||
		ch.settings["param_start"] != "2026-08-01 00:00:00" || ch.settings["param_end"] != "2026-08-31 23:59:59" ||
		ch.settings["param_search"] != "%membership%" {
		t.Errorf("settings = %v", ch.settings)
	}

	memberCH := &orgActivityCH{}
	rec = serveOrgActivity(t, orgActivityDB("member"), memberCH, "/api/v1/orgs/acme/security-events")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member status = %d: %s", rec.Code, rec.Body.String())
	}
	if memberCH.sql != "" {
		t.Errorf("unauthorized request queried ClickHouse: %s", memberCH.sql)
	}
}

func TestOrgAuditLogRequireCapabilityAndScopeQuery(t *testing.T) {
	ch := &orgActivityCH{rows: chActivityRows(2)}
	rec := serveOrgActivity(t, orgActivityDB("owner"), ch,
		"/api/v1/orgs/acme/audit-log?action=org.update&resource_type=organization&resource_id="+orgID.String()+"&resource_name=Acme&resource=team&outcome=success&sensitivity=admin&actor=dev@x.io&request_id=req-1&source=server&ip_address=127.0.0.1&http_method=PATCH&status_code=200&project=core&start_date=2026-08-01&end_date=2026-08-31T23:59:59&q=API%25_path")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{
		"FROM audit_log", "resource_id = {org_id:String}", "http_path LIKE {org_path:String}",
		"action = {f_action:String}", "resource_type = {f_resource_type:String}",
		"resource_id = {f_resource_id:String}", "resource_name = {f_resource_name:String}",
		"outcome = {f_outcome:String}", "sensitivity = {f_sensitivity:String}",
		"actor_email = {f_actor_email:String}", "request_id = {f_request_id:String}",
		"source = {f_source:String}", "ip_address = {f_ip_address:String}",
		"http_method = {f_http_method:String}", "status_code = {f_status_code:UInt16}",
		"http_path LIKE {project_path:String}", "timestamp >= {start:String}", "timestamp <= {end:String}",
		"lowerUTF8(concat(resource_type, ' ', resource_id, ' ', resource_name, ' ', http_path)) LIKE {resource:String}",
		"lowerUTF8(concat(actor_email, ' ', action, ' ', resource_type, ' ', resource_name, ' ', http_method, ' ', http_path, ' ', outcome, ' ', detail)) LIKE {search:String}",
		"ORDER BY timestamp DESC, event_id DESC LIMIT 21",
	} {
		if !strings.Contains(ch.sql, want) {
			t.Errorf("audit SQL missing %q: %s", want, ch.sql)
		}
	}
	if strings.Contains(ch.sql, "OFFSET") {
		t.Errorf("audit query still uses OFFSET pagination: %s", ch.sql)
	}
	if ch.settings["param_org_path"] != "/api/v1/orgs/acme%" || ch.settings["param_f_action"] != "org.update" ||
		ch.settings["param_project_path"] != "/api/v1/orgs/acme/projects/core%" ||
		ch.settings["param_start"] != "2026-08-01 00:00:00" || ch.settings["param_end"] != "2026-08-31 23:59:59" ||
		ch.settings["param_resource"] != "%team%" || ch.settings["param_search"] != `%api\%\_path%` {
		t.Errorf("settings = %v", ch.settings)
	}

	memberCH := &orgActivityCH{}
	rec = serveOrgActivity(t, orgActivityDB("member"), memberCH, "/api/v1/orgs/acme/audit-log")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member status = %d: %s", rec.Code, rec.Body.String())
	}
	if memberCH.sql != "" {
		t.Errorf("unauthorized request queried ClickHouse: %s", memberCH.sql)
	}
}

func TestOrgActivityPaginationEnvelope(t *testing.T) {
	// A full-plus-one result set signals another page and yields a cursor.
	full := &orgActivityCH{rows: chActivityRows(activityDefaultPageSize + 1)}
	resp := decodeActivityResponse(t, serveOrgActivity(t, orgActivityDB("owner"), full, "/api/v1/orgs/acme/audit-log"))
	if !resp.HasMore || len(resp.Events) != activityDefaultPageSize {
		t.Fatalf("has_more=%v events=%d, want true/%d", resp.HasMore, len(resp.Events), activityDefaultPageSize)
	}
	if resp.PageSize != activityDefaultPageSize {
		t.Errorf("page_size = %d, want %d", resp.PageSize, activityDefaultPageSize)
	}
	if resp.NextCursor == nil {
		t.Fatalf("expected a next cursor for a full page")
	}
	cursor, ok := decodeActivityCursor(*resp.NextCursor)
	if !ok || cursor.eventID != fmt.Sprintf("e0000000-0000-4000-8000-%012d", activityDefaultPageSize-1) {
		t.Errorf("next cursor anchors at %+v", cursor)
	}

	custom := &orgActivityCH{rows: chActivityRows(101)}
	resp = decodeActivityResponse(t, serveOrgActivity(t, orgActivityDB("owner"), custom, "/api/v1/orgs/acme/audit-log?page_size=100"))
	if resp.PageSize != 100 || len(resp.Events) != 100 || !strings.Contains(custom.sql, "LIMIT 101") {
		t.Errorf("custom page = %+v sql=%s", resp, custom.sql)
	}

	// A short page is terminal: no cursor, no has_more.
	short := &orgActivityCH{rows: chActivityRows(3)}
	resp = decodeActivityResponse(t, serveOrgActivity(t, orgActivityDB("owner"), short, "/api/v1/orgs/acme/security-events"))
	if resp.HasMore || resp.NextCursor != nil || len(resp.Events) != 3 {
		t.Errorf("short page = %+v", resp)
	}

	// An empty result set serializes as [] with no cursor.
	empty := &orgActivityCH{rows: nil}
	rec := serveOrgActivity(t, orgActivityDB("owner"), empty, "/api/v1/orgs/acme/security-events")
	if !strings.Contains(rec.Body.String(), `"events":[]`) || !strings.Contains(rec.Body.String(), `"next_cursor":null`) {
		t.Errorf("empty page body = %s", rec.Body.String())
	}
}

func TestOrgActivityRedactsSensitiveResponseFields(t *testing.T) {
	ch := &orgActivityCH{rows: []map[string]any{{
		"event_id":   "e0000000-0000-4000-8000-000000000001",
		"timestamp":  "2026-08-30 12:00:00.000",
		"detail":     "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
		"user_agent": "client token=abcdefghijklmnopqrstuvwxyz123456",
	}}}
	rec := serveOrgActivity(t, orgActivityDB("owner"), ch, "/api/v1/orgs/acme/security-events")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "abcdefghijklmnopqrstuvwxyz123456") {
		t.Fatalf("response leaked sensitive value: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "**REDACTED**") {
		t.Fatalf("response did not contain redaction marker: %s", rec.Body.String())
	}
}

func TestOrgActivityCursorNavigationAndValidation(t *testing.T) {
	cursor := encodeActivityCursor("2026-08-30 11:59:59.000", "e0000000-0000-4000-8000-000000000009")

	ch := &orgActivityCH{rows: chActivityRows(2)}
	rec := serveOrgActivity(t, orgActivityDB("owner"), ch, "/api/v1/orgs/acme/audit-log?cursor="+cursor)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(ch.sql, "timestamp < {cursor_ts:String}") || !strings.Contains(ch.sql, "event_id < {cursor_id:UUID}") {
		t.Errorf("descending cursor predicate missing: %s", ch.sql)
	}
	if ch.settings["param_cursor_ts"] != "2026-08-30 11:59:59.000" ||
		ch.settings["param_cursor_id"] != "e0000000-0000-4000-8000-000000000009" {
		t.Errorf("cursor params = %v", ch.settings)
	}

	// Ascending navigation flips the comparison so paging walks forward in time.
	ascCH := &orgActivityCH{rows: chActivityRows(1)}
	serveOrgActivity(t, orgActivityDB("owner"), ascCH, "/api/v1/orgs/acme/audit-log?sort=oldest&cursor="+cursor)
	if !strings.Contains(ascCH.sql, "timestamp > {cursor_ts:String}") || !strings.Contains(ascCH.sql, "event_id > {cursor_id:UUID}") {
		t.Errorf("ascending cursor predicate missing: %s", ascCH.sql)
	}

	// Audit-specific sorts carry the leading sort value in the cursor and then
	// use timestamp/event_id as deterministic tie-breakers.
	slowCursor := encodeActivityCursor("2026-08-30 11:59:59.000", "e0000000-0000-4000-8000-000000000009", "38")
	slowCH := &orgActivityCH{rows: chActivityRows(21)}
	resp := decodeActivityResponse(t, serveOrgActivity(t, orgActivityDB("owner"), slowCH, "/api/v1/orgs/acme/audit-log?sort=slowest&cursor="+slowCursor))
	if !strings.Contains(slowCH.sql, "duration_ms < {cursor_sort:Float64}") ||
		!strings.Contains(slowCH.sql, "ORDER BY duration_ms DESC, timestamp DESC, event_id DESC LIMIT 21") {
		t.Errorf("slowest cursor SQL missing: %s", slowCH.sql)
	}
	if slowCH.settings["param_cursor_sort"] != "38" || resp.NextCursor == nil {
		t.Errorf("slowest cursor response/settings = %+v %v", resp, slowCH.settings)
	}

	// A malformed cursor or direction is rejected before any query runs.
	for _, target := range []string{
		"/api/v1/orgs/acme/audit-log?cursor=not-base64!!",
		"/api/v1/orgs/acme/audit-log?sort=slowest&cursor=" + cursor,
		"/api/v1/orgs/acme/audit-log?sort=actor",
		"/api/v1/orgs/acme/security-events?dir=sideways",
		"/api/v1/orgs/acme/audit-log?page_size=25",
		"/api/v1/orgs/acme/security-events?category=payments",
		"/api/v1/orgs/acme/audit-log?start_date=yesterday",
		"/api/v1/orgs/acme/audit-log?resource=" + strings.Repeat("x", 201),
		"/api/v1/orgs/acme/audit-log?project=" + strings.Repeat("x", 81),
		"/api/v1/orgs/acme/audit-log?q=" + strings.Repeat("x", 201),
	} {
		badCH := &orgActivityCH{}
		rec := serveOrgActivity(t, orgActivityDB("owner"), badCH, target)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s status = %d, want 422", target, rec.Code)
		}
		if badCH.sql != "" {
			t.Errorf("%s queried ClickHouse despite bad input: %s", target, badCH.sql)
		}
	}
}
