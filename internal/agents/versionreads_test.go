// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

var versionCols = []string{
	"id", "agent_id", "version", "description", "status", "is_prerelease",
	"download_count", "supported_harnesses", "released_by", "released_at",
	"created_at", "rejection_reason", "component_count",
}

func versionRow(version, status string) []any {
	return []any{
		versionID, agentID, version, "adds things", status, false,
		int64(4), []any{"kiro"}, viewerID, agentTime,
		agentTime, nil, int64(1),
	}
}

func TestVersionsListRendersPageForOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "ORDER BY v.created_at DESC OFFSET", rows: &fakeRows{cols: versionCols, rows: [][]any{
			versionRow("1.1.0", "approved"),
			versionRow("1.0.0", "pending"),
		}}},
		{match: "SELECT count(*) FROM agent_versions", rows: &fakeRows{cols: []string{"count"}, rows: [][]any{{2}}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/versions?page=1&page_size=10", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var page map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page["total"] != float64(2) || page["page"] != float64(1) || page["page_size"] != float64(10) {
		t.Errorf("pagination: %v", page)
	}
	items := page["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items: %v", items)
	}
	first := items[0].(map[string]any)
	if first["version"] != "1.1.0" || first["component_count"] != float64(1) {
		t.Errorf("summary: %v", first)
	}
	// The creator sees every status: no approved-only clause on the list.
	for _, sql := range db.log {
		if strings.Contains(sql, "OFFSET") && strings.Contains(sql, "AND v.status = 'approved'") {
			t.Errorf("owner list carries the outsider gate: %s", sql)
		}
	}
}

func TestVersionsListHidesUnapprovedFromOutsiders(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "ORDER BY v.created_at DESC OFFSET", rows: &fakeRows{cols: versionCols, rows: [][]any{
			versionRow("1.0.0", "approved"),
		}}},
		{match: "SELECT count(*) FROM agent_versions", rows: &fakeRows{cols: []string{"count"}, rows: [][]any{{1}}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{
			detailRow(map[string]any{"created_by": outsiderID}),
		}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/versions", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	guarded := false
	for _, sql := range db.log {
		if strings.Contains(sql, "OFFSET") && strings.Contains(sql, "AND v.status = 'approved'") {
			guarded = true
		}
	}
	if !guarded {
		t.Errorf("outsider list is missing the approved-only clause: %v", db.log)
	}
}

func TestVersionsListValidatesPagination(t *testing.T) {
	db := &fakeDB{}
	for _, target := range []string{
		"/api/v1/agents/" + agentID + "/versions?page=0",
		"/api/v1/agents/" + agentID + "/versions?page_size=101",
	} {
		rec := serveAgents(t, db, http.MethodGet, target, "user", "")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d", target, rec.Code)
		}
	}
	if len(db.log) != 0 {
		t.Errorf("invalid pagination reached the database: %v", db.log)
	}
}

var versionDetailCols = append(append([]string{}, versionCols...),
	"prompt", "model_name", "model_config_json", "models_by_harness",
	"external_mcps", "yaml_snapshot", "harness_configs",
	"required_capabilities", "inferred_supported_harnesses", "success_criteria")

func versionDetailRow(version, status string) []any {
	return append(versionRow(version, status),
		"You review code.", "claude-sonnet-4-5", map[string]any{}, map[string]any{},
		[]any{}, "version: "+version+"\n", map[string]any{"kiro": map[string]any{}},
		[]any{}, []any{}, nil)
}

func TestVersionDetailRendersComponents(t *testing.T) {
	mcpID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	db := &fakeDB{stubs: []stub{
		{match: "v.yaml_snapshot, v.harness_configs", rows: &fakeRows{cols: versionDetailCols, rows: [][]any{
			versionDetailRow("1.0.0", "approved"),
		}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{
			{"mcp", mcpID, "github-mcp", "1.2.0", int64(0), nil},
		}}},
		{match: "l.name, l.namespace, l.slug, v.status", rows: &fakeRows{cols: refCols, rows: [][]any{
			{mcpID, "github-mcp", "acme", "github-mcp", "approved"},
		}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/versions/1.0.0", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["version"] != "1.0.0" || d["prompt"] != "You review code." || d["yaml_snapshot"] != "version: 1.0.0\n" {
		t.Errorf("detail: %v", d)
	}
	components := d["components"].([]any)
	if len(components) != 1 {
		t.Fatalf("components: %v", components)
	}
	comp := components[0].(map[string]any)
	if comp["name"] != "github-mcp" || comp["resolved_version"] != "1.2.0" || comp["status"] != "approved" {
		t.Errorf("component: %v", comp)
	}
}

func TestVersionDetailNotFoundIs404(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/versions/9.9.9", "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Version not found") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestVersionSuggestionsUseHighestSemver(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT version FROM agent_versions", rows: &fakeRows{cols: []string{"version"}, rows: [][]any{
			{"1.2.3"}, {"0.9.0"}, {"not-semver"},
		}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/version-suggestions", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Current     string `json:"current"`
		Suggestions struct {
			Patch string `json:"patch"`
			Minor string `json:"minor"`
			Major string `json:"major"`
		} `json:"suggestions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Current != "1.2.3" || out.Suggestions.Patch != "1.2.4" ||
		out.Suggestions.Minor != "1.3.0" || out.Suggestions.Major != "2.0.0" {
		t.Errorf("suggestions: %+v", out)
	}
}

func TestHarnessConfigReturnsStoredConfig(t *testing.T) {
	configs := `{"kiro": {"files": [1, 2]}, "cursor": {}}`
	db := &fakeDB{stubs: []stub{
		{match: "harness_configs::text", rows: &fakeRows{cols: []string{"harness_configs"}, rows: [][]any{{configs}}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/harness/kiro", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != `{"files":[1,2]}` {
		t.Errorf("config body: %s", rec.Body.String())
	}
}

func TestHarnessConfigUnknownHarnessListsAvailable(t *testing.T) {
	configs := `{"kiro": {}, "cursor": {}}`
	db := &fakeDB{stubs: []stub{
		{match: "harness_configs::text", rows: &fakeRows{cols: []string{"harness_configs"}, rows: [][]any{{configs}}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/harness/goose", "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "['kiro', 'cursor']") {
		t.Errorf("available list: %s", rec.Body.String())
	}
}

func TestHarnessConfigMissingVersionIs404(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet,
		"/api/v1/agents/"+agentID+"/versions/9.9.9/harness/kiro", "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Version not found") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

var diffCols = []string{
	"id", "version", "description", "prompt", "model_name", "model_config_json",
	"models_by_harness", "external_mcps", "supported_harnesses",
	"success_criteria", "yaml_snapshot",
}

func TestVersionDiffIdenticalVersionsAreEmpty(t *testing.T) {
	mcpID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	db := &fakeDB{stubs: []stub{
		// Empty snapshot text forces on-demand snapshot rendering.
		{match: "v.success_criteria, v.yaml_snapshot", rows: &fakeRows{cols: diffCols, rows: [][]any{
			{versionID, "1.0.0", "reviews code", "prompt", "m", map[string]any{},
				map[string]any{}, []any{}, []any{"kiro"}, nil, ""},
		}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{
			{"mcp", mcpID, "github-mcp", "1.2.0", int64(0), nil},
		}}},
		{match: "l.name, l.namespace, l.slug, v.status", rows: &fakeRows{cols: refCols, rows: [][]any{
			{mcpID, "github-mcp", "acme", "github-mcp", "approved"},
		}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/diff/1.1.0", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["version_a"] != "1.0.0" || d["version_b"] != "1.1.0" || d["yaml_diff"] != "" {
		t.Errorf("diff: %v", d)
	}
	if changes := d["component_changes"].([]any); len(changes) != 0 {
		t.Errorf("component changes on identical versions: %v", changes)
	}
}

func TestVersionDiffMissingVersionIs404(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet,
		"/api/v1/agents/"+agentID+"/versions/1.0.0/diff/1.1.0", "user", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Version '1.0.0' not found") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestRenderYAMLSnapshotMinimal(t *testing.T) {
	row := map[string]any{
		"version": "1.0.0", "description": "d", "model_name": "m", "prompt": "p",
	}
	want := "# Auto-generated snapshot - review the structured fields above and the prompt below.\n" +
		"version: 1.0.0\n" +
		"description: d\n" +
		"model_name: m\n" +
		"models_by_harness: {}\n" +
		"supported_harnesses: []\n" +
		"external_mcps: []\n" +
		"components: []\n" +
		"prompt: p\n"
	if got := renderYAMLSnapshot(row, nil); got != want {
		t.Errorf("snapshot:\ngot  %q\nwant %q", got, want)
	}
}

func TestRenderYAMLSnapshotFullShape(t *testing.T) {
	row := map[string]any{
		"version": "1.2.0", "description": "adds: things", "model_name": "m",
		"models_by_harness":   map[string]any{"kiro": "k1", "cursor": "c1"},
		"supported_harnesses": []any{"kiro"},
		"prompt":              "hello",
		"model_config_json":   map[string]any{"t": float64(1)},
		"success_criteria":    map[string]any{"pass": true},
	}
	components := []map[string]any{
		{"type": "mcp", "id": "abc", "name": "gh", "description": "", "version": "1.0.0"},
		{"type": "prompt", "id": "def", "name": "p", "template": "",
			"config_override": map[string]any{"k": "v"}},
	}
	got := renderYAMLSnapshot(row, components)
	for _, frag := range []string{
		"description: 'adds: things'\n",
		"models_by_harness:\n  cursor: c1\n  kiro: k1\n",
		"supported_harnesses:\n- kiro\n",
		"components:\n- type: mcp\n  id: abc\n  name: gh\n  description: ''\n  version: 1.0.0\n",
		"- type: prompt\n  id: def\n  name: p\n  template: ''\n",
		"config_override: \"{\\\"k\\\":\\\"v\\\"}\"\n",
		"prompt: hello\n",
		"model_config_json: \"{\\\"t\\\":1}\"\n",
		"success_criteria: \"{\\\"pass\\\":true}\"\n",
	} {
		if !strings.Contains(got, frag) {
			t.Errorf("snapshot missing %q:\n%s", frag, got)
		}
	}
}

func TestYAMLScalarQuoting(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "''"},
		{"plain", "plain"},
		{"a:b", "'a:b'"},
		{"a\nb", `"a\nb"`},
		{"- item", "'- item'"},
		{" padded", "' padded'"},
		{"it's", "'it''s'"},
	}
	for _, tc := range cases {
		if got := yamlScalar(tc.in); got != tc.want {
			t.Errorf("yamlScalar(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestJSONKeysInOrder(t *testing.T) {
	got := jsonKeysInOrder(`{"b": 1, "a": {"nested": 2}, "c": [1, 2]}`)
	if !reflect.DeepEqual(got, []string{"b", "a", "c"}) {
		t.Errorf("keys = %v", got)
	}
	if got := jsonKeysInOrder(""); len(got) != 0 {
		t.Errorf("empty input: %v", got)
	}
	if got := jsonKeysInOrder("5"); len(got) != 0 {
		t.Errorf("non-object input: %v", got)
	}
}

func TestPyListRepr(t *testing.T) {
	if got := pyListRepr([]string{"a", "b"}); got != "['a', 'b']" {
		t.Errorf("pyListRepr = %q", got)
	}
	if got := pyListRepr(nil); got != "[]" {
		t.Errorf("empty pyListRepr = %q", got)
	}
}
