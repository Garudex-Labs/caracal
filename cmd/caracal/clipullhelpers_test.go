// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestPullValidationErr(t *testing.T) {
	cerr := pullValidationErr("bad", "res", "fix")
	if cerr.Category != clierr.Validation || cerr.Operation != pullOp {
		t.Errorf("unexpected error: %+v", cerr)
	}
	un := pullUnavailableErr("down", "res", "fix", "detail")
	if un.Category != clierr.Unavailable || un.Detail != "detail" {
		t.Errorf("unexpected error: %+v", un)
	}
}

func TestPullAssignments(t *testing.T) {
	out, cerr := pullAssignments([]string{"KEY=value", `TOKEN="quoted"`}, "env")
	if cerr != nil {
		t.Fatalf("valid assignments rejected: %v", cerr)
	}
	if out.str("KEY") != "value" || out.str("TOKEN") != "quoted" {
		t.Errorf("assignments parsed wrong: KEY=%q TOKEN=%q", out.str("KEY"), out.str("TOKEN"))
	}
	for _, bad := range []string{"NOEQUALS", "=value", "KEY="} {
		if _, cerr := pullAssignments([]string{bad}, "env"); cerr == nil {
			t.Errorf("assignment %q should fail", bad)
		}
	}
}

func TestResolvePullPath(t *testing.T) {
	target := t.TempDir()
	resolved, cerr := resolvePullPath("sub/config.json", target, false)
	if cerr != nil {
		t.Fatalf("safe path rejected: %v", cerr)
	}
	if !strings.HasPrefix(resolved, target) {
		t.Errorf("resolved path escaped target: %s", resolved)
	}

	// allowHome maps ~/ to the user home directory.
	home, _ := os.UserHomeDir()
	resolved, cerr = resolvePullPath("~/note.txt", target, true)
	if cerr != nil {
		t.Fatalf("home path rejected: %v", cerr)
	}
	if !strings.HasPrefix(resolved, home) {
		t.Errorf("home path not under home: %s", resolved)
	}

	// Without allowHome, ~/ is stripped and joined under the target.
	resolved, cerr = resolvePullPath("~/note.txt", target, false)
	if cerr != nil || !strings.HasPrefix(resolved, target) {
		t.Errorf("stripped home path wrong: %s %v", resolved, cerr)
	}

	// A traversal escape is rejected.
	if _, cerr := resolvePullPath("../../escape.txt", target, false); cerr == nil {
		t.Error("escaping path must be rejected")
	}
}

func TestWritePullFileString(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	status, cerr := writePullFile(path, "hello", false)
	if cerr != nil {
		t.Fatalf("write failed: %v", cerr)
	}
	if status != "created" {
		t.Errorf("status = %q, want created", status)
	}
	blob, _ := os.ReadFile(path)
	if string(blob) != "hello" {
		t.Errorf("file content = %q", string(blob))
	}
	// A second write over the existing file reports "updated".
	status, cerr = writePullFile(path, "again", false)
	if cerr != nil {
		t.Fatalf("second write failed: %v", cerr)
	}
	if status != "updated" {
		t.Errorf("status = %q, want updated", status)
	}
}

func TestWritePullFileJSONOmap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	servers := newOmap()
	weather := newOmap()
	weather.set("command", "npx")
	servers.set("weather", weather)
	root := newOmap()
	root.set("mcpServers", servers)
	status, cerr := writePullFile(path, root, false)
	if cerr != nil {
		t.Fatalf("write failed: %v", cerr)
	}
	if status != "created" {
		t.Errorf("status = %q", status)
	}
	blob, _ := os.ReadFile(path)
	if !strings.Contains(string(blob), "mcpServers") || !strings.Contains(string(blob), "npx") {
		t.Errorf("json file missing content:\n%s", string(blob))
	}
}

func TestWritePullFileYAMLOmap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	servers := newOmap()
	entry := newOmap()
	entry.set("command", "npx")
	servers.set("weather", entry)
	root := newOmap()
	root.set("mcpServers", servers)
	status, cerr := writePullFile(path, root, false)
	if cerr != nil {
		t.Fatalf("write failed: %v", cerr)
	}
	if status != "created" {
		t.Errorf("status = %q", status)
	}
	blob, _ := os.ReadFile(path)
	if !strings.Contains(string(blob), "mcpServers:") {
		t.Errorf("yaml file missing content:\n%s", string(blob))
	}
}

func buildMCPOmap() *omap {
	server := newOmap()
	server.set("command", "npx")
	server.set("args", []any{"-y", "server"})
	server.set("enabled", true)
	servers := newOmap()
	servers.set("weather", server)
	root := newOmap()
	root.set("mcpServers", servers)
	return root
}

func TestDictToTOML(t *testing.T) {
	rendered := dictToTOML(buildMCPOmap())
	if !strings.Contains(rendered, "[mcpServers.weather]") {
		t.Errorf("missing table header:\n%s", rendered)
	}
	if !strings.Contains(rendered, `command = "npx"`) {
		t.Errorf("missing string field:\n%s", rendered)
	}
	if !strings.Contains(rendered, "args = [") {
		t.Errorf("missing array field:\n%s", rendered)
	}
	if !strings.Contains(rendered, "enabled = true") {
		t.Errorf("missing bool field:\n%s", rendered)
	}
}

func TestMergeTOMLText(t *testing.T) {
	content := buildMCPOmap()
	rendered := dictToTOML(content)

	// No matching header: rendered content is appended to the existing text.
	merged, err := mergeTOMLText("[other.thing]\nkey = 1\n", rendered, content, "mcpServers", "config.toml")
	if err != nil {
		t.Fatalf("append merge failed: %v", err)
	}
	if !strings.Contains(merged, "[other.thing]") || !strings.Contains(merged, "[mcpServers.weather]") {
		t.Errorf("append merge lost content:\n%s", merged)
	}

	// An existing matching table is replaced in place.
	existing := "[mcpServers.weather]\ncommand = \"old\"\n"
	merged, err = mergeTOMLText(existing, rendered, content, "mcpServers", "config.toml")
	if err != nil {
		t.Fatalf("replace merge failed: %v", err)
	}
	if strings.Contains(merged, `command = "old"`) {
		t.Errorf("old table not replaced:\n%s", merged)
	}
}

func TestMergeYAMLConfigNewFile(t *testing.T) {
	content := buildMCPOmap()
	rendered, status, err := mergeYAMLConfig("/nonexistent.yaml", content, "mcpServers", false, false)
	if err != nil {
		t.Fatalf("new-file merge failed: %v", err)
	}
	if status != "created" {
		t.Errorf("status = %q, want created", status)
	}
	if !strings.Contains(rendered, "mcpServers:") {
		t.Errorf("rendered yaml missing section:\n%s", rendered)
	}
}

func TestMergeYAMLConfigMergesExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	seedFile(t, path, "mcpServers:\n  existing:\n    command: old\n")
	content := buildMCPOmap()
	rendered, status, err := mergeYAMLConfig(path, content, "mcpServers", true, true)
	if err != nil {
		t.Fatalf("merge failed: %v", err)
	}
	if status != "merged" {
		t.Errorf("status = %q, want merged", status)
	}
	if !strings.Contains(rendered, "existing:") || !strings.Contains(rendered, "weather:") {
		t.Errorf("merge must keep both servers:\n%s", rendered)
	}
}

func TestResolveHookPathsNoop(t *testing.T) {
	// The bundled hook scripts are not on PATH in the test environment, so
	// the content passes through unchanged.
	in := `"caracal-hook.sh" and "caracal-stop-hook.sh"`
	if got := resolveHookPaths(in); got != in {
		t.Errorf("expected unchanged content, got %q", got)
	}
}

func TestCollectPullValuesNoPrompt(t *testing.T) {
	required := newOmap()
	required.set("name", "API_KEY")
	required.set("required", true)
	optional := newOmap()
	optional.set("name", "REGION")
	optional.set("required", false)
	overrides := newOmap()
	overrides.set("API_KEY", "secret")
	out := collectPullValues([]any{required, optional}, overrides, true, "weather", "environment variable", true)
	if out.str("API_KEY") != "secret" {
		t.Errorf("override not applied: %q", out.str("API_KEY"))
	}
	if out.has("REGION") {
		t.Error("unset optional must be omitted in no-prompt mode")
	}
}
