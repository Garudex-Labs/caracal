// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestWorkspaceSourceState(t *testing.T) {
	now := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	plain := workspaceSourceState("telemetry", "fresh", "", now)
	if plain.Message != nil || plain.Status != "fresh" || plain.UpdatedAt != "2026-08-30T08:00:00Z" {
		t.Errorf("plain: %+v", plain)
	}
	withMsg := workspaceSourceState("registry", "partial", "degraded", now)
	if withMsg.Message == nil || *withMsg.Message != "degraded" {
		t.Errorf("with message: %+v", withMsg)
	}
}

func TestWorkspaceRowTimestamp(t *testing.T) {
	if workspaceRowTimestamp(map[string]any{}, "last_used") != nil {
		t.Error("missing key should be nil")
	}
	if workspaceRowTimestamp(map[string]any{"last_used": nil}, "last_used") != nil {
		t.Error("nil value should be nil")
	}
	if workspaceRowTimestamp(map[string]any{"last_used": "1970-01-01 00:00:00"}, "last_used") != nil {
		t.Error("epoch sentinel should be nil")
	}
	got := workspaceRowTimestamp(map[string]any{"last_used": "2026-08-30 08:00:00"}, "last_used")
	if got == nil || *got != "2026-08-30 08:00:00" {
		t.Errorf("valid timestamp: %v", got)
	}
}

func TestWorkspaceIntQueryParam(t *testing.T) {
	get := func(query string) (*httptest.ResponseRecorder, *http.Request) {
		return httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x"+query, nil)
	}
	w, r := get("")
	if v, ok := workspaceIntQueryParam(w, r, "page", 7, 100); !ok || v != 7 {
		t.Errorf("fallback: %d %v", v, ok)
	}
	w, r = get("?page=5")
	if v, ok := workspaceIntQueryParam(w, r, "page", 1, 100); !ok || v != 5 {
		t.Errorf("value: %d %v", v, ok)
	}
	for _, bad := range []string{"?page=abc", "?page=0", "?page=101"} {
		w, r = get(bad)
		if _, ok := workspaceIntQueryParam(w, r, "page", 1, 100); ok {
			t.Errorf("%s accepted", bad)
		}
		if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "between 1 and 100") {
			t.Errorf("%s: status = %d: %s", bad, w.Code, w.Body.String())
		}
	}
}

func intelligenceStubs(role string, extra ...stub) []stub {
	return append([]stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, role)),
	}, extra...)
}

func TestIntelligenceRangeValidation(t *testing.T) {
	db := &fakeDB{stubs: intelligenceStubs("lead")}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/projects/app/intelligence/briefing?range=bogus", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "string_pattern_mismatch") ||
		!strings.Contains(rec.Body.String(), workspaceRangePattern) {
		t.Errorf("422 shape: %s", rec.Body.String())
	}
}

// agentSnapshotStub answers the loadResourceSnapshot registry read.
func agentSnapshotStub(rows [][]any) stub {
	return stub{match: "FROM agents a LEFT JOIN agent_versions", rows: &fakeRows{rows: rows}}
}

func agentRowValues(id uuid.UUID, name, slug string) []any {
	return []any{id, name, "acme", slug, "richard", "1.2.0", "approved", orgTime}
}

func TestIntelligenceResourceIndexValidation(t *testing.T) {
	base := "/api/v1/orgs/acme/projects/app/intelligence/resources"
	cases := []struct{ query, needle string }{
		{"?page=bogus", "between 1 and 10000"},
		{"?focus=everything", "string_pattern_mismatch"},
		{"?sort=alphabetical", "string_pattern_mismatch"},
	}
	for _, c := range cases {
		db := &fakeDB{stubs: intelligenceStubs("lead")}
		rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, base+c.query, "")
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), c.needle) {
			t.Errorf("%s: status = %d: %s", c.query, rec.Code, rec.Body.String())
		}
	}
}

func TestIntelligenceResourceIndexWithoutTelemetry(t *testing.T) {
	agentA := uuid.MustParse("88888888-8888-8888-8888-888888888888")
	db := &fakeDB{stubs: intelligenceStubs("lead",
		agentSnapshotStub([][]any{agentRowValues(agentA, "Helper", "helper")}),
		stub{match: "FROM agent_download_records", rows: &fakeRows{rows: [][]any{{agentA, 3, 1}}}},
		stub{match: "FROM review_issues", rows: &fakeRows{rows: [][]any{{agentA, 2, 5}}}},
	)}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/projects/app/intelligence/resources", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body: %v", err)
	}
	if out["total"] != float64(1) || out["cost_restricted"] != false {
		t.Errorf("envelope: total=%v cost_restricted=%v", out["total"], out["cost_restricted"])
	}
	rows, _ := out["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows: %v", out["rows"])
	}
	row, _ := rows[0].(map[string]any)
	if row["qualified_name"] != "acme/helper" || row["version"] != "1.2.0" {
		t.Errorf("registry fields: %v", row)
	}
	// Telemetry is down: usage metrics stay null instead of fabricated zeroes.
	if row["sessions"] != nil || row["credits"] != nil {
		t.Errorf("telemetry fields must be null: %v", row)
	}
	if row["downloads"] != float64(3) || row["open_issues"] != float64(2) {
		t.Errorf("registry counters: %v", row)
	}
	reasons, _ := row["attention_reasons"].([]any)
	if len(reasons) != 1 || reasons[0] != "open review issues" {
		t.Errorf("attention: %v", row["attention_reasons"])
	}
	telemetryUnavailable := false
	for _, s := range out["sources"].([]any) {
		src, _ := s.(map[string]any)
		if src["name"] == "telemetry" && src["status"] == "unavailable" {
			telemetryUnavailable = true
		}
	}
	if !telemetryUnavailable {
		t.Errorf("sources must flag telemetry unavailable: %v", out["sources"])
	}
}

func TestIntelligenceResourceCompare(t *testing.T) {
	base := "/api/v1/orgs/acme/projects/app/intelligence/resources/compare"
	agentA := uuid.MustParse("88888888-8888-8888-8888-888888888888")
	agentB := uuid.MustParse("99999999-9999-9999-9999-999999999999")

	db := &fakeDB{stubs: intelligenceStubs("lead")}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, base+"?a="+agentA.String(), "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing b: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: intelligenceStubs("lead")}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		base+"?a="+agentA.String()+"&b="+agentA.String(), "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("same ids: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: intelligenceStubs("lead")}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		base+"?a="+agentA.String()+"&b="+agentB.String(), "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown resources: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: intelligenceStubs("lead",
		agentSnapshotStub([][]any{
			agentRowValues(agentA, "Helper", "helper"),
			agentRowValues(agentB, "Builder", "builder"),
		}),
	)}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		base+"?a="+agentA.String()+"&b="+agentB.String(), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("compare: status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	left, _ := out["a"].(map[string]any)
	right, _ := out["b"].(map[string]any)
	if left["agent_id"] != agentA.String() || right["agent_id"] != agentB.String() {
		t.Errorf("sides: a=%v b=%v", left["agent_id"], right["agent_id"])
	}
	deltas, _ := out["deltas"].(map[string]any)
	if deltas == nil || deltas["sessions_pct"] != nil {
		t.Errorf("deltas without telemetry: %v", out["deltas"])
	}
}

func TestIntelligenceResourceVersions(t *testing.T) {
	agentA := uuid.MustParse("88888888-8888-8888-8888-888888888888")
	base := "/api/v1/orgs/acme/projects/app/intelligence/resources/"

	db := &fakeDB{stubs: intelligenceStubs("lead")}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, base+"nope/versions", "")
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "resource must be a UUID") {
		t.Errorf("bad uuid: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: intelligenceStubs("lead",
		stub{match: "SELECT EXISTS(SELECT 1 FROM agents", rows: &fakeRows{rows: [][]any{{false}}}},
	)}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, base+agentA.String()+"/versions", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Resource not found") {
		t.Errorf("missing: status = %d: %s", rec.Code, rec.Body.String())
	}

	released := time.Date(2026, 8, 29, 12, 0, 0, 0, time.UTC)
	db = &fakeDB{stubs: intelligenceStubs("lead",
		stub{match: "SELECT EXISTS(SELECT 1 FROM agents", rows: &fakeRows{rows: [][]any{{true}}}},
		stub{match: "FROM agent_versions", rows: &fakeRows{rows: [][]any{
			{"1.2.0", "approved", released},
			{"1.1.0", "rejected", nil},
		}}},
	)}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, base+agentA.String()+"/versions", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	versions, _ := out["versions"].([]any)
	if len(versions) != 2 {
		t.Fatalf("versions: %v", out["versions"])
	}
	first, _ := versions[0].(map[string]any)
	if first["version"] != "1.2.0" || first["released_at"] != "2026-08-29T12:00:00Z" {
		t.Errorf("version wire: %v", first)
	}
	// Telemetry unavailable: usage stays null and the source says so.
	if first["sessions"] != nil {
		t.Errorf("sessions must be null: %v", first)
	}
}

func TestIntelligenceHistoryListsVersionEvents(t *testing.T) {
	occurred := time.Date(2026, 8, 28, 9, 0, 0, 0, time.UTC)
	db := &fakeDB{stubs: intelligenceStubs("lead",
		stub{match: "FROM agent_versions v JOIN agents a", rows: &fakeRows{rows: [][]any{
			{"ver-1", "agent-1", "Helper", "acme", "helper", "1.2.0", "approved", occurred},
		}}},
	)}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/projects/app/intelligence/history", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "version_released") || !strings.Contains(body, "Helper released 1.2.0") {
		t.Errorf("history events: %s", body)
	}

	db = &fakeDB{stubs: intelligenceStubs("lead")}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/projects/app/intelligence/history?page_size=bogus", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad page_size: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestIntelligenceBriefingWithoutTelemetry(t *testing.T) {
	agentA := uuid.MustParse("88888888-8888-8888-8888-888888888888")
	db := &fakeDB{stubs: intelligenceStubs("user",
		agentSnapshotStub([][]any{agentRowValues(agentA, "Helper", "helper")}),
	)}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/projects/app/intelligence/briefing", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body: %v", err)
	}
	telemetryUnavailable := false
	for _, s := range out["sources"].([]any) {
		src, _ := s.(map[string]any)
		if src["name"] == "telemetry" && src["status"] == "unavailable" {
			telemetryUnavailable = true
		}
	}
	if !telemetryUnavailable {
		t.Errorf("telemetry source must be unavailable: %v", out["sources"])
	}
}
