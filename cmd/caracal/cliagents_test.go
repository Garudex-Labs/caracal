// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

const (
	agentUUID = "3f8f3f61-3b19-4b6c-a6a1-24dfb8a7c001"
	mcpUUID   = "5a4f3f61-3b19-4b6c-a6a1-24dfb8a7c002"
	userUUID  = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
)

// initAgentDir runs non-interactive agent init into a fresh directory.
func initAgentDir(t *testing.T, name string) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "agent", "init", "--dir", dir,
		"--name", name, "--description", "does things", "--prompt", "be helpful")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestAgentInitWritesDefinitionFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	out, err := captureCLI(t, "agent", "init", "--dir", dir,
		"--name", "helper", "--description", "does things", "--prompt", "be helpful",
		"--model", "gpt-5", "--harness", "kiro", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Path  string `json:"path"`
		Agent struct {
			Name               string   `json:"name"`
			Version            string   `json:"version"`
			ModelName          string   `json:"model_name"`
			SupportedHarnesses []string `json:"supported_harnesses"`
			Components         []any    `json:"components"`
		} `json:"agent"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("init output is not JSON:\n%s", out)
	}
	if doc.Agent.Name != "helper" || doc.Agent.Version != "1.0.0" || doc.Agent.ModelName != "gpt-5" {
		t.Errorf("agent fields: %+v", doc.Agent)
	}
	if len(doc.Agent.SupportedHarnesses) != 1 || doc.Agent.SupportedHarnesses[0] != "kiro" {
		t.Errorf("harness flag must narrow the list: %v", doc.Agent.SupportedHarnesses)
	}
	blob, rerr := os.ReadFile(filepath.Join(dir, "caracal-agent.yaml"))
	if rerr != nil {
		t.Fatalf("definition file: %v", rerr)
	}
	if !strings.Contains(string(blob), "name: helper") || !strings.Contains(string(blob), "prompt: be helpful") {
		t.Errorf("YAML content:\n%s", blob)
	}
}

func TestAgentInitSlugifiesDisplayNames(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	out, err := captureCLI(t, "agent", "init", "--dir", dir,
		"--name", "My Helper", "--description", "d", "--prompt", "p")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "my-helper") {
		t.Errorf("slugified name must be announced:\n%s", out)
	}
	blob, _ := os.ReadFile(filepath.Join(dir, "caracal-agent.yaml"))
	if !strings.Contains(string(blob), "name: my-helper") {
		t.Errorf("YAML must store the slug:\n%s", blob)
	}
}

func TestAgentInitBetaStartsAtZeroOne(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "agent", "init", "--dir", dir, "--beta",
		"--name", "helper", "--description", "d", "--prompt", "p")
	if err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(filepath.Join(dir, "caracal-agent.yaml"))
	if !strings.Contains(string(blob), "version: 0.1.0") {
		t.Errorf("beta version:\n%s", blob)
	}
}

func TestAgentInitJSONModeRequiresAllFields(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "agent", "init", "--dir", t.TempDir(), "--name", "helper", "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "--description") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestAgentInitExistingFileConflictsInJSONMode(t *testing.T) {
	dir := initAgentDir(t, "helper")
	_, err := captureCLI(t, "agent", "init", "--dir", dir,
		"--name", "helper", "--description", "d", "--prompt", "p", "-o", "json")
	if asCLIError(t, err).Category != clierr.Conflict {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}

func TestAgentInitMissingPromptFileIsNotFound(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "agent", "init", "--dir", t.TempDir(),
		"--name", "helper", "--description", "d", "--prompt-file", "/nonexistent/prompt.md")
	if asCLIError(t, err).Category != clierr.NotFound {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}

func TestAgentAddAppendsComponentToYAML(t *testing.T) {
	dir := initAgentDir(t, "helper")
	out, err := captureCLI(t, "agent", "add", "mcp", mcpUUID, "--dir", dir, "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Component struct {
			ComponentType string `json:"component_type"`
			ComponentID   string `json:"component_id"`
		} `json:"component"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.Component.ComponentType != "mcp" || doc.Component.ComponentID != mcpUUID {
		t.Errorf("add output:\n%s", out)
	}
	blob, _ := os.ReadFile(filepath.Join(dir, "caracal-agent.yaml"))
	if !strings.Contains(string(blob), "component_id: "+mcpUUID) {
		t.Errorf("component missing from YAML:\n%s", blob)
	}
}

func TestAgentAddDuplicateComponentConflicts(t *testing.T) {
	dir := initAgentDir(t, "helper")
	if _, err := captureCLI(t, "agent", "add", "mcp", mcpUUID, "--dir", dir); err != nil {
		t.Fatal(err)
	}
	_, err := captureCLI(t, "agent", "add", "mcp", mcpUUID, "--dir", dir)
	if asCLIError(t, err).Category != clierr.Conflict {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}

func TestAgentAddRejectsUnknownTypeLocally(t *testing.T) {
	dir := initAgentDir(t, "helper")
	_, err := captureCLI(t, "agent", "add", "widget", mcpUUID, "--dir", dir)
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "widget") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestAgentAddRejectsNonUUIDLocally(t *testing.T) {
	dir := initAgentDir(t, "helper")
	_, err := captureCLI(t, "agent", "add", "mcp", "not-a-uuid", "--dir", dir)
	if asCLIError(t, err).Category != clierr.Validation {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}

func TestAgentAddWithoutDefinitionFails(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "agent", "add", "mcp", mcpUUID, "--dir", t.TempDir())
	if err == nil {
		t.Fatal("add must fail without caracal-agent.yaml")
	}
	_ = asCLIError(t, err)
}

func TestAgentBuildValidatesComponentsAgainstRegistry(t *testing.T) {
	dir := initAgentDir(t, "helper")
	if _, err := captureCLI(t, "agent", "add", "mcp", mcpUUID, "--dir", dir); err != nil {
		t.Fatal(err)
	}
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/mcps/" + mcpUUID:  {body: `{"id": "` + mcpUUID + `", "name": "weather"}`},
		"POST /api/v1/agents/validate": {body: `{"issues": []}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "agent", "build", "--dir", dir, "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Valid      bool  `json:"valid"`
		Components []any `json:"components"`
		Issues     []any `json:"issues"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || !doc.Valid || len(doc.Components) != 1 {
		t.Errorf("build result:\n%s", out)
	}
	validate, ok := rec.find("POST", "/api/v1/agents/validate")
	if !ok {
		t.Fatalf("validate never posted: %v", rec.lines())
	}
	if !strings.Contains(validate.Body, mcpUUID) || !strings.Contains(validate.Body, `"visibility":"project"`) {
		t.Errorf("validate body = %s", validate.Body)
	}
}

func TestAgentBuildReportsMissingComponents(t *testing.T) {
	dir := initAgentDir(t, "helper")
	if _, err := captureCLI(t, "agent", "add", "mcp", mcpUUID, "--dir", dir); err != nil {
		t.Fatal(err)
	}
	srv := fakeAPI(t, map[string]apiResponse{
		// The component lookup 404s; validate still runs.
		"POST /api/v1/agents/validate": {body: `{"issues": []}`},
	})
	_, err := runCLI(t, srv, "agent", "build", "--dir", dir)
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "1 issue(s)") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Detail, `"valid": false`) {
		t.Errorf("detail must carry the component report: %s", cerr.Detail)
	}
}

func TestAgentBuildNoComponentsIsLocalNoop(t *testing.T) {
	dir := initAgentDir(t, "helper")
	// No server configured: an empty component list must not hit the network.
	out, err := captureCLI(t, "agent", "build", "--dir", dir, "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"valid": true`) {
		t.Errorf("empty build must be valid:\n%s", out)
	}
}

func TestAgentListRejectsBadPagingLocally(t *testing.T) {
	_, err := runCLI(t, nil, "agent", "list", "--limit", "0")
	if asCLIError(t, err).Category != clierr.Usage {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
	_, err = runCLI(t, nil, "agent", "list", "--page", "0")
	if asCLIError(t, err).Category != clierr.Usage {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}
