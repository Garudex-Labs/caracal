// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"path/filepath"
	"strings"
	"testing"
)

const installMCPUUID = "22222222-3333-4444-5555-666666666666"

func mcpInstallRoutes(installBody string) map[string]apiResponse {
	return map[string]apiResponse{
		"GET /api/v1/mcps/" + installMCPUUID: {body: `{
			"id": "` + installMCPUUID + `",
			"name": "Weather",
			"namespace": "acme",
			"slug": "weather",
			"environment_variables": [{"name": "API_KEY", "required": true}]
		}`},
		"POST /api/v1/mcps/" + installMCPUUID + "/install": {body: installBody},
	}
}

func TestMCPInstallJSONFlow(t *testing.T) {
	rec := newRecordingAPI(t, mcpInstallRoutes(`{"config_snippet": {"mcpServers": {"weather": {"command": "npx"}}}, "harness": "cursor"}`))
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "mcp", "install", installMCPUUID,
		"--harness", "cursor", "--no-prompt", "-o", "json")
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	if !strings.Contains(out, "mcpServers") {
		t.Errorf("server response not passed through:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/mcps/"+installMCPUUID+"/install")
	if !ok {
		t.Fatal("install POST not recorded")
	}
	// No-prompt fills the required var with a placeholder token.
	if !strings.Contains(req.Body, "cursor") || !strings.Contains(req.Body, "API_KEY") {
		t.Errorf("install body missing harness/env: %s", req.Body)
	}
}

func TestMCPInstallRawSnippet(t *testing.T) {
	rec := newRecordingAPI(t, mcpInstallRoutes(`{"config_snippet": {"mcpServers": {"weather": {"command": "npx"}}}}`))
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "mcp", "install", installMCPUUID,
		"--harness", "cursor", "--no-prompt", "--raw")
	if err != nil {
		t.Fatalf("raw install failed: %v", err)
	}
	if !strings.Contains(out, "mcpServers") || !strings.Contains(out, "npx") {
		t.Errorf("raw snippet not printed:\n%s", out)
	}
}

func TestMCPInstallWithEnvFlags(t *testing.T) {
	rec := newRecordingAPI(t, mcpInstallRoutes(`{"config_snippet": {"ok": true}}`))
	recEnv(t, rec)
	_, err := captureCLI(t, "registry", "mcp", "install", installMCPUUID,
		"--harness", "cursor", "--env", "API_KEY=secret123", "--no-prompt", "-o", "json")
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	req, ok := rec.find("POST", "/api/v1/mcps/"+installMCPUUID+"/install")
	if !ok {
		t.Fatal("install POST not recorded")
	}
	if !strings.Contains(req.Body, "secret123") {
		t.Errorf("env value not forwarded: %s", req.Body)
	}
}

func TestMCPInstallWithEnvFile(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	seedFile(t, envPath, "# comment\nAPI_KEY=fromfile\nlowercase=ignored\n")
	rec := newRecordingAPI(t, mcpInstallRoutes(`{"config_snippet": {"ok": true}}`))
	recEnv(t, rec)
	_, err := captureCLI(t, "registry", "mcp", "install", installMCPUUID,
		"--harness", "cursor", "--env-file", envPath, "--no-prompt", "-o", "json")
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	req, _ := rec.find("POST", "/api/v1/mcps/"+installMCPUUID+"/install")
	if !strings.Contains(req.Body, "fromfile") {
		t.Errorf("env-file value not forwarded: %s", req.Body)
	}
	if strings.Contains(req.Body, "lowercase") {
		t.Errorf("lowercase env keys must be skipped: %s", req.Body)
	}
}

func TestMCPInstallTableSummary(t *testing.T) {
	rec := newRecordingAPI(t, mcpInstallRoutes(`{"config_snippet": {"ok": true}, "installed": true}`))
	recEnv(t, rec)
	out, err := captureCLI(t, "registry", "mcp", "install", installMCPUUID,
		"--harness", "cursor", "--no-prompt")
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	if strings.TrimSpace(out) == "" {
		t.Error("table summary must print something")
	}
}

func TestParseAssignments(t *testing.T) {
	out, cerr := parseAssignments([]string{"A=1", `B="two"`}, "environment variable", "op")
	if cerr != nil {
		t.Fatalf("valid assignments rejected: %v", cerr)
	}
	if out.str("A") != "1" || out.str("B") != "two" {
		t.Errorf("parsed wrong: A=%q B=%q", out.str("A"), out.str("B"))
	}
	if _, cerr := parseAssignments([]string{"=noKey"}, "environment variable", "op"); cerr == nil {
		t.Error("missing key must fail")
	}
	if _, cerr := parseAssignments([]string{"NOEQ"}, "environment variable", "op"); cerr == nil {
		t.Error("missing '=' must fail")
	}
}

func TestListingVarNames(t *testing.T) {
	req := newOmap()
	req.set("name", "API_KEY")
	req.set("required", true)
	opt := newOmap()
	opt.set("name", "REGION")
	opt.set("required", false)
	noName := newOmap()
	names := listingVarNames([]any{req, opt, noName, "junk"})
	if len(names) != 2 {
		t.Fatalf("want 2 named entries, got %d", len(names))
	}
	if names[0].Name != "API_KEY" || !names[0].Required {
		t.Errorf("first entry wrong: %+v", names[0])
	}
	if names[1].Required {
		t.Errorf("second entry must be optional: %+v", names[1])
	}
}
