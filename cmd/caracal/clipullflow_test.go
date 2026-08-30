// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const pullAgentUUID = "11111111-2222-3333-4444-555555555555"

func pullAgentRoutes(snippet string) map[string]apiResponse {
	return map[string]apiResponse{
		"GET /api/v1/agents/" + pullAgentUUID: {body: `{
			"id": "` + pullAgentUUID + `",
			"name": "reviewer",
			"namespace": "acme",
			"slug": "reviewer",
			"version": "1.0.0",
			"qualified_name": "acme/reviewer",
			"component_links": []
		}`},
		"POST /api/v1/agents/" + pullAgentUUID + "/install": {body: snippet},
	}
}

func TestPullDryRunJSON(t *testing.T) {
	snippet := `{
		"config_snippet": {
			"mcp_config": {"path": ".mcp.json", "content": {"mcpServers": {"weather": {"command": "npx"}}}},
			"agent_profile": {"path": "AGENTS.md", "content": "Agent profile body"}
		},
		"warnings": ["review before use"]
	}`
	rec := newRecordingAPI(t, pullAgentRoutes(snippet))
	home := recEnv(t, rec)
	dir := filepath.Join(home, "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLI(t, "agent", "pull", pullAgentUUID, "--harness", "claude-code",
		"--dir", dir, "--no-prompt", "--dry-run", "-o", "json")
	if err != nil {
		t.Fatalf("pull dry run failed: %v", err)
	}
	var doc struct {
		Harness string `json:"harness"`
		DryRun  bool   `json:"dry_run"`
		Files   []struct {
			Path   string `json:"path"`
			Status string `json:"status"`
		} `json:"files"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if doc.Harness != "claude-code" || !doc.DryRun {
		t.Errorf("unexpected header: %+v", doc)
	}
	if len(doc.Files) != 2 {
		t.Fatalf("want 2 planned files, got %d: %+v", len(doc.Files), doc.Files)
	}
	for _, f := range doc.Files {
		if f.Status != "would write" {
			t.Errorf("dry-run status = %q for %s", f.Status, f.Path)
		}
	}
	if len(doc.Warnings) != 1 {
		t.Errorf("warnings = %v", doc.Warnings)
	}
	// Dry run must not touch the filesystem.
	if _, err := os.Stat(filepath.Join(dir, ".mcp.json")); !os.IsNotExist(err) {
		t.Error("dry run must not write files")
	}
}

func TestPullWritesFiles(t *testing.T) {
	snippet := `{
		"config_snippet": {
			"mcp_config": {"path": ".mcp.json", "content": {"mcpServers": {"weather": {"command": "npx"}}}},
			"agent_profile": {"path": "AGENTS.md", "content": "Agent profile body"}
		}
	}`
	rec := newRecordingAPI(t, pullAgentRoutes(snippet))
	home := recEnv(t, rec)
	dir := filepath.Join(home, "proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLI(t, "agent", "pull", pullAgentUUID, "--harness", "claude-code",
		"--dir", dir, "--no-prompt")
	if err != nil {
		t.Fatalf("pull failed: %v", err)
	}
	if !strings.Contains(out, "Pulled claude-code config") {
		t.Errorf("success message missing:\n%s", out)
	}
	mcpBlob, err := os.ReadFile(filepath.Join(dir, ".mcp.json"))
	if err != nil {
		t.Fatalf(".mcp.json not written: %v", err)
	}
	if !strings.Contains(string(mcpBlob), "weather") {
		t.Errorf(".mcp.json content wrong:\n%s", string(mcpBlob))
	}
	profileBlob, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil {
		t.Fatalf("AGENTS.md not written: %v", err)
	}
	if !strings.Contains(string(profileBlob), "Agent profile body") {
		t.Errorf("profile content wrong:\n%s", string(profileBlob))
	}
	// The install request must carry the harness selection.
	req, ok := rec.find("POST", "/api/v1/agents/"+pullAgentUUID+"/install")
	if !ok {
		t.Fatal("install not recorded")
	}
	if !strings.Contains(req.Body, "claude-code") {
		t.Errorf("install body missing harness: %s", req.Body)
	}
}

func TestPullEmptySnippetFails(t *testing.T) {
	rec := newRecordingAPI(t, pullAgentRoutes(`{"config_snippet": {}}`))
	home := recEnv(t, rec)
	dir := filepath.Join(home, "proj")
	_ = os.MkdirAll(dir, 0o755)
	_, err := captureCLI(t, "agent", "pull", pullAgentUUID, "--harness", "claude-code",
		"--dir", dir, "--no-prompt")
	cerr := asCLIError(t, err)
	if !strings.Contains(cerr.Message, "empty agent configuration") {
		t.Errorf("expected empty-config error, got: %s", cerr.Message)
	}
}

func TestPullJSONModeRequiresNoPrompt(t *testing.T) {
	_, err := runCLI(t, nil, "agent", "pull", pullAgentUUID, "--harness", "claude-code", "-o", "json")
	cerr := asCLIError(t, err)
	if !strings.Contains(cerr.Message, "cannot prompt") {
		t.Errorf("expected prompt-mode error, got: %s", cerr.Message)
	}
}

func TestPullRejectsToolsForNonClaude(t *testing.T) {
	_, err := runCLI(t, nil, "agent", "pull", pullAgentUUID, "--harness", "cursor",
		"--tools", "Bash", "--no-prompt")
	cerr := asCLIError(t, err)
	if !strings.Contains(cerr.Message, "--tools") {
		t.Errorf("expected tools rejection, got: %s", cerr.Message)
	}
}

func TestPullRejectsBadModelOverride(t *testing.T) {
	_, err := runCLI(t, nil, "agent", "pull", pullAgentUUID, "--harness", "claude-code",
		"--model", "kiro=gpt-4", "--no-prompt")
	cerr := asCLIError(t, err)
	if !strings.Contains(cerr.Message, "model override") && !strings.Contains(cerr.Message, "does not target") {
		t.Errorf("expected model override rejection, got: %s", cerr.Message)
	}
}
