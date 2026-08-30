// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseInstallBodyValidation(t *testing.T) {
	t.Run("missing harness", func(t *testing.T) {
		errs := []fieldError{}
		parseInstallBody(map[string]any{}, &errs)
		if len(errs) != 1 || errs[0].Type != "missing" || errs[0].Loc[1] != "harness" {
			t.Errorf("errs = %+v", errs)
		}
	})
	t.Run("harness wrong type", func(t *testing.T) {
		errs := []fieldError{}
		parseInstallBody(map[string]any{"harness": 42}, &errs)
		if len(errs) != 1 || errs[0].Type != "string_type" {
			t.Errorf("errs = %+v", errs)
		}
	})
	t.Run("full body", func(t *testing.T) {
		errs := []fieldError{}
		body := parseInstallBody(map[string]any{
			"harness": "kiro", "local_name": "wx", "version": "1.0.0",
			"scope": "user", "platform": "linux",
			"env_values":    map[string]any{"API_KEY": "k", "num": 3},
			"header_values": map[string]any{"X-Auth": "t"},
		}, &errs)
		if len(errs) != 0 {
			t.Fatalf("errs = %+v", errs)
		}
		if body.Harness != "kiro" || body.LocalName != "wx" || body.Version != "1.0.0" ||
			body.Scope != "user" || body.Platform != "linux" {
			t.Errorf("body = %+v", body)
		}
		if body.EnvValues["API_KEY"] != "k" || len(body.EnvValues) != 1 {
			t.Errorf("env values keep strings only: %v", body.EnvValues)
		}
		if body.HeaderValues["X-Auth"] != "t" {
			t.Errorf("header values: %v", body.HeaderValues)
		}
	})
	t.Run("scope defaults to project", func(t *testing.T) {
		errs := []fieldError{}
		body := parseInstallBody(map[string]any{"harness": "kiro"}, &errs)
		if body.Scope != "project" {
			t.Errorf("scope = %q", body.Scope)
		}
	})
}

func TestShortDescription(t *testing.T) {
	long := strings.Repeat("word ", 50) + "end. Second sentence."
	cases := []struct{ in, want string }{
		{"", ""},
		{"One liner", "One liner"},
		{"## Header line\nrest", "Header line"},
		{long, strings.TrimSpace(strings.SplitN(long, ".", 2)[0])},
	}
	for _, c := range cases {
		if got := shortDescription(c.in); got != c.want {
			t.Errorf("shortDescription(%.20q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("", "", "x", "y"); got != "x" {
		t.Errorf("got %q", got)
	}
	if got := firstNonEmpty(); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestArchivedInstallWarning(t *testing.T) {
	got := archivedInstallWarning("MCP", "Weather")
	if got != "Archived MCP 'Weather' is deprecated and may be removed from future agent pulls." {
		t.Errorf("warning = %q", got)
	}
}

func TestServerURLDerivation(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcps/x/install", nil)
	req.Host = "registry.example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	if got := h.serverURL(req.Context(), req); got != "https://registry.example.com" {
		t.Errorf("forwarded proto: %q", got)
	}
	req.Header.Del("X-Forwarded-Proto")
	if got := h.serverURL(req.Context(), req); got != "http://registry.example.com" {
		t.Errorf("default proto: %q", got)
	}
	if got := h.serverURL(req.Context(), nil); got != "http://localhost:8080" {
		t.Errorf("no request: %q", got)
	}
}

func installBodyJSON(harness string) *strings.Reader {
	return strings.NewReader(`{"harness":"` + harness + `"}`)
}

func TestInstallBodyContractErrors(t *testing.T) {
	target := "/api/v1/mcps/" + listingUUID + "/install"
	cases := []struct {
		name string
		body *strings.Reader
		frag string
	}{
		{"empty body", strings.NewReader(""), `"missing"`},
		{"invalid json", strings.NewReader("{"), `"json_invalid"`},
		{"missing harness", strings.NewReader(`{"local_name":"x"}`), `"harness"`},
	}
	for _, c := range cases {
		rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost, target, "user", c.body)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d: %s", c.name, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), c.frag) {
			t.Errorf("%s: body: %s", c.name, rec.Body.String())
		}
	}
}

func TestInstallUnknownListing404(t *testing.T) {
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/install", "user", installBodyJSON("kiro"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Listing not found or not approved") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestInstallMcpApprovedRendersSnippet(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{
		"command": "npx", "args": []any{"-y", "weather-mcp"},
		"environment_variables": []any{map[string]any{"name": "API_KEY"}},
	})}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/install", "user", installBodyJSON("kiro"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp installResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body: %v", err)
	}
	if resp.ListingID != listingUUID || resp.Harness != "kiro" || len(resp.Warnings) != 0 {
		t.Errorf("response: %+v", resp)
	}
	servers, ok := resp.ConfigSnippet["mcpServers"].(map[string]any)
	if !ok {
		t.Fatalf("config snippet: %v", resp.ConfigSnippet)
	}
	if _, ok := servers["weather"]; !ok {
		t.Errorf("snippet keyed by slug: %v", servers)
	}
	// The install is recorded and the version counter bumped.
	var sawDownload, sawBump bool
	for _, sql := range db.log {
		if strings.Contains(sql, "INSERT INTO mcp_downloads") {
			sawDownload = true
		}
		if strings.Contains(sql, "download_count = download_count + 1") {
			sawBump = true
		}
	}
	if !sawDownload || !sawBump {
		t.Errorf("download record missing: download=%v bump=%v\n%v", sawDownload, sawBump, db.log)
	}
}

func TestInstallMcpOwnerFallbackForPending(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "v.status = 'approved'", rows: &fakeRows{}},
		mcpShowStub(map[string]any{"status": "pending"}),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/install", "user", installBodyJSON("kiro"))
	if rec.Code != http.StatusOK {
		t.Fatalf("owner pending install: status = %d: %s", rec.Code, rec.Body.String())
	}

	// A non-owner cannot install the same pending listing.
	outsider := &fakeDB{stubs: []stub{
		{match: "v.status = 'approved'", rows: &fakeRows{}},
		mcpShowStub(map[string]any{"status": "pending", "submitted_by": otherUserID}),
	}}
	rec = serveRegistryReq(t, outsider, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/install", "user", installBodyJSON("kiro"))
	if rec.Code != http.StatusNotFound {
		t.Errorf("outsider pending install: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestInstallMcpArchivedWarnsAnyViewer(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "v.status = 'approved'", rows: &fakeRows{}},
		mcpShowStub(map[string]any{"status": "archived", "submitted_by": otherUserID}),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/install", "user", installBodyJSON("kiro"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp installResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(resp.Warnings) != 1 || !strings.Contains(resp.Warnings[0], "Archived MCP 'Weather'") {
		t.Errorf("warnings: %v", resp.Warnings)
	}
}

func TestInstallMcpSetupInstructionsWarn(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"setup_instructions": "run make"})}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/install", "user", installBodyJSON("kiro"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "requires local setup before use") {
		t.Errorf("setup warning missing: %s", rec.Body.String())
	}
}

func TestInstallMcpUnknownHarnessIs500(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(nil)}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/install", "user", installBodyJSON("warpdrive"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "No adapter registered for harness: 'warpdrive'") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

// skillShowStub answers the skill detail resolve with a minimal row.
func skillShowStub(over map[string]any) stub {
	base := map[string]any{
		"id": listingUUID, "name": "Sifter", "namespace": "acme", "slug": "sifter",
		"submitted_by": testViewerID, "co_authors": []any{}, "status": "approved",
		"latest_version_id": versionUUID, "version": "2.0.0",
		"description": "sift things", "ownership_scope": "user", "is_private": false,
		"slash_command": nil,
	}
	for k, v := range over {
		base[k] = v
	}
	cols := make([]string, 0, len(base))
	row := make([]any, 0, len(base))
	for k, v := range base {
		cols = append(cols, k)
		row = append(row, v)
	}
	return stub{match: "FROM skill_listings", rows: &fakeRows{cols: cols, rows: [][]any{row}}}
}

func TestInstallSkillVersionNotFound(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "WHERE listing_id = $1 AND version = $2", rows: &fakeRows{}},
		skillShowStub(nil),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/skills/"+listingUUID+"/install", "user",
		strings.NewReader(`{"harness":"claude-code","version":"9.9.9"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Version '9.9.9' not found for this skill") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestInstallSkillRendersTelemetryConfig(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM skill_versions WHERE id = $1", rows: &fakeRows{
			cols: []string{"version", "description", "delivery_mode", "script_content", "script_filename", "git_url"},
			rows: [][]any{{"2.0.0", "sift deeply", "registry_direct", "echo hi", "run.sh", "https://example.com/repo.git"}},
		}},
		skillShowStub(nil),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/skills/"+listingUUID+"/install", "user", installBodyJSON("claude-code"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp installResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body: %v", err)
	}
	skill, ok := resp.ConfigSnippet["skill"].(map[string]any)
	if !ok {
		t.Fatalf("skill block: %v", resp.ConfigSnippet)
	}
	if skill["delivery_mode"] != "registry_direct" || skill["script_content"] != "echo hi" ||
		skill["script_filename"] != "run.sh" || skill["git_url"] != "https://example.com/repo.git" {
		t.Errorf("skill info: %v", skill)
	}
	hooks, ok := resp.ConfigSnippet["hooks"].(map[string]any)
	if !ok {
		t.Fatalf("hooks block: %v", resp.ConfigSnippet)
	}
	if _, ok := hooks["SessionStart"]; !ok {
		t.Errorf("hook events: %v", hooks)
	}
	if resp.ConfigSnippet["listing_id"] != listingUUID {
		t.Errorf("listing id: %v", resp.ConfigSnippet["listing_id"])
	}
}

// hookShowStub answers the hook detail resolve with a minimal row.
func hookShowStub() stub {
	cols := []string{"id", "name", "namespace", "slug", "submitted_by", "co_authors",
		"status", "latest_version_id", "version", "ownership_scope", "is_private"}
	return stub{match: "FROM hook_listings", rows: &fakeRows{cols: cols, rows: [][]any{
		{listingUUID, "Formatter", "acme", "formatter", testViewerID, []any{},
			"approved", versionUUID, "1.0.0", "user", false},
	}}}
}

func hookSourceStub(event string, config map[string]any, script, filename string) stub {
	return stub{match: "FROM hook_versions WHERE id = $1", rows: &fakeRows{
		cols: []string{"event", "handler_type", "handler_config", "script_content", "script_filename"},
		rows: [][]any{{event, "command", config, script, filename}},
	}}
}

func TestInstallHookUnknownHarnessAnswersNotes(t *testing.T) {
	db := &fakeDB{stubs: []stub{hookShowStub()}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/hooks/"+listingUUID+"/install", "user", installBodyJSON("warpdrive"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp hookInstallResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(resp.Notes) != 1 || !strings.Contains(resp.Notes[0], "harness 'warpdrive' is not recognized") {
		t.Errorf("notes: %v", resp.Notes)
	}
}

func TestInstallHookUnsupportedEventAnswersNotes(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		hookSourceStub("Notification", map[string]any{"command": "fmt"}, "", ""),
		hookShowStub(),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/hooks/"+listingUUID+"/install", "user", installBodyJSON("kiro"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp hookInstallResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(resp.Notes) != 2 || !strings.Contains(resp.Notes[0], "Event 'Notification' is not supported by Kiro") {
		t.Fatalf("notes: %v", resp.Notes)
	}
	if !strings.Contains(resp.Notes[1], "Supported events:") {
		t.Errorf("supported list: %v", resp.Notes[1])
	}
}

func TestInstallHookDeliversScriptFile(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		hookSourceStub("PreToolUse", map[string]any{"command": "fmt", "timeout": float64(5)}, "#!/bin/sh\nfmt", "fmt.sh"),
		hookShowStub(),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/hooks/"+listingUUID+"/install", "user", installBodyJSON("kiro"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp hookInstallResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(resp.Files) != 1 || resp.Files[0]["path"] != ".kiro/hooks/fmt.sh" ||
		resp.Files[0]["executable"] != true {
		t.Fatalf("files: %v", resp.Files)
	}
	if resp.ConfigPath != ".kiro/hooks/formatter.json" {
		t.Errorf("config path: %q", resp.ConfigPath)
	}
	if len(resp.ConfigSnippet) == 0 {
		t.Errorf("empty config snippet")
	}
}

func TestInstallHookOpenCodePluginInstructions(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		hookSourceStub("PreToolUse", map[string]any{"command": "fmt"}, "", ""),
		hookShowStub(),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/hooks/"+listingUUID+"/install", "user", installBodyJSON("opencode"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp hookInstallResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body: %v", err)
	}
	if resp.ConfigSnippet["_manual_setup"] != true || resp.ConfigSnippet["event"] != "tool.execute.before" {
		t.Errorf("plugin snippet: %v", resp.ConfigSnippet)
	}
	if resp.ConfigPath != ".opencode/plugins/formatter.ts" {
		t.Errorf("config path: %q", resp.ConfigPath)
	}
}
