// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const (
	mcpListingID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	skillListingID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
)

var mcpResolveCols = []string{
	"id", "name", "slug", "version", "description", "status",
	"transport", "tools_schema", "mcp_validated", "setup_instructions",
	"git_url", "git_ref",
}

var skillResolveCols = []string{
	"id", "name", "slug", "version", "description", "status",
	"skill_path", "task_type", "slash_command", "skill_md_content",
	"git_url", "git_ref",
}

func composedAgentStubs(mcpStatus string) []stub {
	return []stub{
		{match: "v.transport", rows: &fakeRows{cols: mcpResolveCols, rows: [][]any{
			{mcpListingID, "github-mcp", "github-mcp", "1.2.0", "gh tools", mcpStatus,
				"stdio", map[string]any{"tools": []any{"x"}}, true, nil, "https://git.example/mcp", "main"},
		}}},
		{match: "v.skill_path", rows: &fakeRows{cols: skillResolveCols, rows: [][]any{
			{skillListingID, "review-skill", "review-skill", "0.3.0", "reviews", "approved",
				"/skills", "review", nil, "skill body", nil, nil},
		}}},
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{
			{"mcp", mcpListingID, "github-mcp", "1.2.0", int64(0), nil},
			{"skill", skillListingID, "review-skill", "0.3.0", int64(1), nil},
		}}},
		{match: "l.name, l.namespace, l.slug, v.status", rows: &fakeRows{cols: refCols, rows: [][]any{
			{mcpListingID, "github-mcp", "acme", "github-mcp", "approved"},
			{skillListingID, "review-skill", "acme", "review-skill", "approved"},
		}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}
}

func TestResolveCompositionSummary(t *testing.T) {
	db := &fakeDB{stubs: composedAgentStubs("approved")}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/resolve", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["resolved"] != true || d["agent_name"] != "review-bot" || d["agent_version"] != "1.0.0" {
		t.Errorf("summary head: %v", d)
	}
	counts := d["component_counts"].(map[string]any)
	if counts["mcp"] != float64(1) || counts["skill"] != float64(1) {
		t.Errorf("counts: %v", counts)
	}
	components := d["components"].(map[string]any)
	mcps := components["mcps"].([]any)
	if len(mcps) != 1 || mcps[0].(map[string]any)["name"] != "github-mcp" {
		t.Errorf("mcps: %v", mcps)
	}
	if len(d["errors"].([]any)) != 0 {
		t.Errorf("errors: %v", d["errors"])
	}
}

func TestResolveReportsUnapprovedComponents(t *testing.T) {
	db := &fakeDB{stubs: composedAgentStubs("pending")}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/resolve", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &d)
	if d["resolved"] != false {
		t.Errorf("resolved flag: %v", d["resolved"])
	}
	errs := d["errors"].([]any)
	if len(errs) != 1 {
		t.Fatalf("errors: %v", errs)
	}
	reason := errs[0].(map[string]any)["reason"].(string)
	if !strings.Contains(reason, "'github-mcp' is not approved (status: pending)") {
		t.Errorf("reason: %s", reason)
	}
}

func TestResolveReportsMissingAndUnknownComponents(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_components WHERE agent_version_id", rows: &fakeRows{cols: linkCols, rows: [][]any{
			{"mcp", mcpListingID, "github-mcp", "1.2.0", int64(0), nil},
			{"gadget", "cccccccc-cccc-cccc-cccc-cccccccccccc", "widget", "1.0.0", int64(1), nil},
		}}},
		{match: "a.id = $", rows: &fakeRows{cols: detailCols, rows: [][]any{detailRow(nil)}}},
	}}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/resolve", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, "Unknown component type: gadget") ||
		!strings.Contains(out, "mcp listing "+mcpListingID+" not found") {
		t.Errorf("errors: %s", out)
	}
}

func TestManifestRendersPopulatedFields(t *testing.T) {
	db := &fakeDB{stubs: composedAgentStubs("approved")}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/manifest", "user", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["name"] != "review-bot" || d["version"] != "1.0.0" {
		t.Errorf("manifest head: %v", d)
	}
	components := d["components"].(map[string]any)
	mcp := components["mcps"].([]any)[0].(map[string]any)
	if mcp["git_url"] != "https://git.example/mcp" || mcp["git_ref"] != "main" || mcp["transport"] != "stdio" {
		t.Errorf("mcp entry: %v", mcp)
	}
	skill := components["skills"].([]any)[0].(map[string]any)
	override := skill["config_override"].(map[string]any)
	if override["skill_md_content"] != "skill body" || skill["task_type"] != "review" {
		t.Errorf("skill entry: %v", skill)
	}
	if _, present := d["errors"]; present {
		t.Errorf("clean manifest carries errors: %v", d)
	}
}

func TestManifestUnresolvableIs422(t *testing.T) {
	db := &fakeDB{stubs: composedAgentStubs("pending")}
	rec := serveAgents(t, db, http.MethodGet, "/api/v1/agents/"+agentID+"/manifest", "user", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Agent has unresolvable components") {
		t.Errorf("body: %s", rec.Body.String())
	}
}

func TestExtractExtraHookConditionalKeys(t *testing.T) {
	bare := extractExtra(map[string]any{
		"event": "pre_tool", "handler_type": "script",
	}, "hook")
	for _, absent := range []string{"source_url", "script_filename", "requirements"} {
		if _, ok := bare[absent]; ok {
			t.Errorf("bare hook leaked %q: %v", absent, bare)
		}
	}
	if bare["execution_mode"] != "async" || bare["priority"] != int64(100) || bare["scope"] != "agent" {
		t.Errorf("hook defaults: %v", bare)
	}

	full := extractExtra(map[string]any{
		"event": "pre_tool", "handler_type": "script", "priority": int32(5),
		"source_url": "https://src", "source_ref": "main", "resolved_sha": "abc",
		"script_filename": "run.sh", "requirements": "requests",
	}, "hook")
	if full["source_url"] != "https://src" || full["script_filename"] != "run.sh" ||
		full["requirements"] != "requests" || full["priority"] != int64(5) {
		t.Errorf("hook extras: %v", full)
	}
}

func TestExtractExtraPrompt(t *testing.T) {
	prompt := extractExtra(map[string]any{
		"template": "Hi {{name}}", "variables": []any{"name"}, "category": "greet",
	}, "prompt")
	if prompt["template"] != "Hi {{name}}" || prompt["category"] != "greet" {
		t.Errorf("prompt extras: %v", prompt)
	}
}

func TestManifestComponentTypeBranches(t *testing.T) {
	hook := manifestComponent(resolvedComponent{
		ComponentType: "hook", Name: "guard", Version: "1.0.0",
		Extra: map[string]any{
			"event": "pre_tool", "execution_mode": "sync", "priority": int64(10),
			"handler_type": "script", "handler_config": map[string]any{"cmd": "x"},
		},
	})
	if hook["event"] != "pre_tool" || hook["execution_mode"] != "sync" || hook["handler_type"] != "script" {
		t.Errorf("hook manifest: %v", hook)
	}

	prompt := manifestComponent(resolvedComponent{
		ComponentType: "prompt", Name: "p", Version: "1.0.0",
		Extra: map[string]any{"template": "T", "variables": []any{"a"}},
	})
	if prompt["template"] != "T" || len(prompt["variables"].([]any)) != 1 {
		t.Errorf("prompt manifest: %v", prompt)
	}
}

func TestAgentManifestTopLevelFields(t *testing.T) {
	r := &resolvedAgent{
		AgentName: "bot", AgentVersion: "2.0.0", AgentPrompt: "P", AgentDesc: "D",
		ModelName: "m", ModelsByHarness: map[string]any{"kiro": "k"},
		Errors: []resolutionError{{ComponentType: "mcp", ComponentID: "x", Reason: "gone"}},
	}
	out := agentManifest(r)
	if out["prompt"] != "P" || out["description"] != "D" || out["model_name"] != "m" {
		t.Errorf("manifest: %v", out)
	}
	if _, ok := out["models_by_harness"]; !ok {
		t.Errorf("models_by_harness dropped: %v", out)
	}
	if len(out["errors"].([]resolutionError)) != 1 {
		t.Errorf("errors dropped: %v", out)
	}

	minimal := agentManifest(&resolvedAgent{AgentName: "bot", AgentVersion: "1.0.0"})
	for _, absent := range []string{"prompt", "description", "model_name", "models_by_harness", "errors"} {
		if _, ok := minimal[absent]; ok {
			t.Errorf("minimal manifest leaked %q: %v", absent, minimal)
		}
	}
}

func TestRowIntDefault(t *testing.T) {
	row := map[string]any{"a": int64(1), "b": int32(2), "c": int16(3), "d": "x"}
	if rowIntDefault(row, "a", 9) != 1 || rowIntDefault(row, "b", 9) != 2 || rowIntDefault(row, "c", 9) != 3 {
		t.Error("integer conversions wrong")
	}
	if rowIntDefault(row, "d", 9) != 9 || rowIntDefault(row, "missing", 9) != 9 {
		t.Error("default not applied")
	}
}

func TestItemSlug(t *testing.T) {
	if got := itemSlug(map[string]any{"slug": "s", "name": "n"}); got != "s" {
		t.Errorf("slug preferred: %q", got)
	}
	if got := itemSlug(map[string]any{"name": "n"}); got != "n" {
		t.Errorf("name fallback: %q", got)
	}
}
