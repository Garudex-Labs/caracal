// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestIsFilteredEnvVar(t *testing.T) {
	filtered := []string{"PATH", "HOME", "GITHUB_ACTIONS", "CI_JOB", "DOCKER_HOST_EXTRA"}
	for _, name := range filtered {
		if !isFilteredEnvVar(name) {
			t.Errorf("isFilteredEnvVar(%q) = false, want true", name)
		}
	}
	kept := []string{"GITHUB_TOKEN", "MY_TOKEN", "OPENAI_API_KEY"}
	for _, name := range kept {
		if isFilteredEnvVar(name) {
			t.Errorf("isFilteredEnvVar(%q) = true, want false", name)
		}
	}
}

func TestExtractDollarVarsFiltersInternal(t *testing.T) {
	env := newOmap()
	env.set("A", "$HOME/path")
	got := extractDollarVars([]string{"--token", "${MY_TOKEN}", "$PATH"}, env)
	if !reflect.DeepEqual(got, []string{"MY_TOKEN"}) {
		t.Errorf("extractDollarVars = %v, want [MY_TOKEN]", got)
	}
}

func TestUnwrapMCPConfigVariants(t *testing.T) {
	inner, name := unwrapMCPConfig(mustOmap(t, `{"mcpServers":{"weather":{"command":"npx"}}}`))
	if name != "weather" || inner.str("command") != "npx" {
		t.Errorf("mcpServers unwrap = %q / %v", name, inner)
	}
	inner, name = unwrapMCPConfig(mustOmap(t, `{"command":"go"}`))
	if name != "" || inner.str("command") != "go" {
		t.Errorf("direct command unwrap = %q / %v", name, inner)
	}
	inner, name = unwrapMCPConfig(mustOmap(t, `{"weather":{"command":"npx"}}`))
	if name != "weather" || inner.str("command") != "npx" {
		t.Errorf("single-key wrap unwrap = %q / %v", name, inner)
	}
}

func TestTruthyClassifiesShapes(t *testing.T) {
	if truthy(nil) || truthy("") || truthy(false) || truthy([]any{}) || truthy(newOmap()) {
		t.Error("empty shapes must be falsy")
	}
	if !truthy("x") || !truthy(true) || !truthy([]any{1}) {
		t.Error("non-empty shapes must be truthy")
	}
	// json.Number "0" is falsy while "5" is truthy.
	if truthy(mustOmap(t, `{"n":0}`).get("n")) {
		t.Error("numeric zero must be falsy")
	}
	if !truthy(mustOmap(t, `{"n":5}`).get("n")) {
		t.Error("numeric five must be truthy")
	}
}

func TestStringsOfFiltersNonStrings(t *testing.T) {
	if got := stringsOf([]any{"a", 1, "b", nil}); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Errorf("stringsOf = %v", got)
	}
	if stringsOf("not a list") != nil {
		t.Error("non-array input must return nil")
	}
}

func TestEnvVarEntriesFromKeys(t *testing.T) {
	entries := envVarEntries(mustOmap(t, `{"A":"1","B":"2"}`))
	if len(entries) != 2 {
		t.Fatalf("want 2 entries, got %d", len(entries))
	}
	first := entries[0].(*omap)
	if first.str("name") != "A" || first.get("required") != true {
		t.Errorf("first entry wrong: %v", first)
	}
}

func TestParseDirectConfigStdioCommand(t *testing.T) {
	parsed := parseDirectConfig(mustOmap(t, `{"command":"npx","args":["-y","@scope/pkg"],"env":{"MY_TOKEN":"${MY_TOKEN}"}}`))
	if parsed.str("transport") != "stdio" || parsed.str("command") != "npx" {
		t.Errorf("stdio fields wrong: %v", parsed)
	}
	if parsed.str("framework") != "typescript" {
		t.Errorf("npx framework = %q, want typescript", parsed.str("framework"))
	}
	envVars := parsed.array("environment_variables")
	if len(envVars) != 1 || envVars[0].(*omap).str("name") != "MY_TOKEN" {
		t.Errorf("env vars wrong: %v", envVars)
	}
	// Detected variables are stored as a []string, not a JSON array.
	if dollar, _ := parsed.get("_dollar_vars_detected").([]string); len(dollar) != 1 {
		t.Errorf("dollar vars = %v", dollar)
	}
}

func TestParseDirectConfigDockerImage(t *testing.T) {
	parsed := parseDirectConfig(mustOmap(t, `{"command":"docker","args":["run","-i","--rm","ghcr.io/x/y:1"]}`))
	if parsed.str("framework") != "docker" {
		t.Errorf("framework = %q, want docker", parsed.str("framework"))
	}
	if parsed.str("docker_image") != "ghcr.io/x/y:1" {
		t.Errorf("docker_image = %q", parsed.str("docker_image"))
	}
}

func TestParseDirectConfigRemoteURL(t *testing.T) {
	parsed := parseDirectConfig(mustOmap(t, `{"url":"https://api.example.com/sse","type":"sse","headers":{"Authorization":"Bearer abc"}}`))
	if parsed.str("transport") != "sse" {
		t.Errorf("transport = %q, want sse", parsed.str("transport"))
	}
	if got, _ := parsed.get("url").(string); got != "https://api.example.com/sse" {
		t.Errorf("url = %q", got)
	}
	if len(parsed.array("headers")) != 1 {
		t.Errorf("headers = %v", parsed.array("headers"))
	}
}

func TestParseServerJSONManifestRemotes(t *testing.T) {
	parsed := parseServerJSONManifest(mustOmap(t,
		`{"remotes":[{"url":"https://r.example.com","type":"streamable-http","variables":{"TOKEN":{"description":"tok"}}}]}`))
	if parsed == nil {
		t.Fatal("manifest with remotes must parse")
	}
	if parsed.str("url") != "https://r.example.com" || parsed.str("transport") != "streamable-http" {
		t.Errorf("remote fields wrong: %v", parsed)
	}
	envVars := parsed.array("environment_variables")
	if len(envVars) != 1 || envVars[0].(*omap).str("name") != "TOKEN" {
		t.Errorf("remote env vars wrong: %v", envVars)
	}
}

func TestParseServerJSONManifestPackages(t *testing.T) {
	parsed := parseServerJSONManifest(mustOmap(t,
		`{"server":{"name":"foo","description":"d","packages":[{"runtimeArguments":[{"value":"MY_VAR=x","description":"desc"}]}]}}`))
	if parsed == nil {
		t.Fatal("manifest with packages must parse")
	}
	if parsed.str("_server_name") != "foo" || parsed.str("transport") != "stdio" || parsed.str("framework") != "docker" {
		t.Errorf("package manifest fields wrong: %v", parsed)
	}
	envVars := parsed.array("environment_variables")
	if len(envVars) != 1 || envVars[0].(*omap).str("name") != "MY_VAR" {
		t.Errorf("package env vars wrong: %v", envVars)
	}
}

func TestParseServerJSONManifestReturnsNilWithoutPackagesOrRemotes(t *testing.T) {
	if parseServerJSONManifest(mustOmap(t, `{"command":"go"}`)) != nil {
		t.Error("config without packages/remotes must return nil")
	}
}

func TestLoadJSONObjectFileCategories(t *testing.T) {
	dir := t.TempDir()
	if _, cerr := loadJSONObjectFile(filepath.Join(dir, "absent.json"), "Op", "file"); cerr == nil || cerr.Category != clierr.NotFound {
		t.Errorf("missing file must be NotFound, got %v", cerr)
	}
	badPath := filepath.Join(dir, "bad.json")
	_ = writeTestFile(t, badPath, "not json")
	if _, cerr := loadJSONObjectFile(badPath, "Op", "file"); cerr == nil || cerr.Category != clierr.Validation {
		t.Errorf("invalid JSON must be Validation, got %v", cerr)
	}
	arrPath := filepath.Join(dir, "arr.json")
	_ = writeTestFile(t, arrPath, "[1,2,3]")
	if _, cerr := loadJSONObjectFile(arrPath, "Op", "file"); cerr == nil || cerr.Category != clierr.Validation {
		t.Errorf("non-object must be Validation, got %v", cerr)
	}
	okPath := filepath.Join(dir, "ok.json")
	_ = writeTestFile(t, okPath, `{"name":"x"}`)
	obj, cerr := loadJSONObjectFile(okPath, "Op", "file")
	if cerr != nil || obj["name"] != "x" {
		t.Errorf("valid object load failed: %v / %v", obj, cerr)
	}
}

func TestAddPublishTargetDefaultsAndValidates(t *testing.T) {
	payload := map[string]any{}
	if cerr := addPublishTarget(payload, "", "registry mcp submit"); cerr != nil {
		t.Fatalf("empty visibility: %v", cerr)
	}
	if payload["visibility"] != "public" {
		t.Errorf("default visibility = %v, want public", payload["visibility"])
	}
	if cerr := addPublishTarget(payload, "project", "registry mcp submit"); cerr != nil || payload["visibility"] != "project" {
		t.Errorf("project visibility failed: %v / %v", cerr, payload["visibility"])
	}
	if cerr := addPublishTarget(payload, "bogus", "registry mcp submit"); cerr == nil {
		t.Error("invalid visibility must error")
	}
}

func TestDraftSubmitConflictIsValidation(t *testing.T) {
	if cerr := draftSubmitConflict("Submit MCP server"); cerr.Category != clierr.Validation {
		t.Errorf("draftSubmitConflict category = %s", cerr.Category)
	}
}

func TestAppendDollarVarsAddsMissingOnly(t *testing.T) {
	parsed := newOmap()
	existing := newOmap()
	existing.set("name", "EXISTING")
	existing.set("required", true)
	parsed.set("environment_variables", []any{existing})
	env := newOmap()
	env.set("A", "${NEW_VAR}")
	appendDollarVars(parsed, nil, env)
	names := map[string]bool{}
	for _, raw := range parsed.array("environment_variables") {
		names[raw.(*omap).str("name")] = true
	}
	if !names["EXISTING"] || !names["NEW_VAR"] {
		t.Errorf("appendDollarVars names = %v", names)
	}
}

// writeTestFile writes content and returns the path, failing on error.
func writeTestFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}
