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

// seedFile writes one file creating parents.
func seedFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// seededHome creates a HOME with kiro, cursor, and claude-code configs and
// the auth env doctor patch requires.
func seededHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CARACAL_SERVER_URL", "http://127.0.0.1:1")
	t.Setenv("CARACAL_ACCESS_TOKEN", "test-token")
	seedFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"other_setting": true}`)
	seedFile(t, filepath.Join(home, ".kiro", "settings", "mcp.json"),
		`{"mcpServers": {"mailer": {"command": "python", "args": ["-m", "m"]}}}`)
	seedFile(t, filepath.Join(home, ".cursor", "mcp.json"),
		`{"mcpServers": {"gh": {"url": "https://mcp.example/sse"}}}`)
	return home
}

func TestScanDiscoversInstalledMcpsPerHarness(t *testing.T) {
	seededHome(t)
	out, err := captureCLI(t, "scan")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"name":"mailer"`, `"source":"kiro:global"`,
		`"name":"gh"`, `"source":"cursor:global"`,
		`"url":"https://mcp.example/sse"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("scan missing %q:\n%s", want, out)
		}
	}
	// Hook state distinguishes a config without hooks from no config at all.
	if !strings.Contains(out, `{"hooks":"missing","name":"claude-code"}`) {
		t.Errorf("claude-code hook state:\n%s", out)
	}
	if !strings.Contains(out, `{"hooks":"missing","name":"kiro"}`) &&
		!strings.Contains(out, `{"hooks":"none","name":"kiro"}`) {
		t.Errorf("kiro hook state:\n%s", out)
	}
}

func TestScanEmptyHomeFindsNothing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// Table mode os.Exit(1)s on an empty home; JSON mode returns the empty envelope.
	out, err := captureCLI(t, "scan", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Harnesses []any `json:"harnesses"`
		Mcps      []any `json:"mcps"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("scan json output:\n%s", out)
	}
	if len(doc.Harnesses) != 0 || len(doc.Mcps) != 0 {
		t.Errorf("empty home must not discover components:\n%s", out)
	}
}

func TestDoctorPatchInstallsAndCleanupRemovesHooks(t *testing.T) {
	home := seededHome(t)
	settingsPath := filepath.Join(home, ".claude", "settings.json")

	if _, err := captureCLI(t, "doctor", "patch", "--harness", "claude-code"); err != nil {
		t.Fatalf("patch: %v", err)
	}
	blob, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := json.Unmarshal(blob, &settings); err != nil {
		t.Fatalf("patched settings are not JSON: %v\n%s", err, blob)
	}
	if settings["hooks"] == nil {
		t.Fatalf("patch did not install hooks:\n%s", blob)
	}
	if settings["other_setting"] != true {
		t.Error("patch must preserve unrelated user settings")
	}
	// The command references the invoking binary, so assert the stable suffix.
	if !strings.Contains(string(blob), "hook session-push --harness claude-code") {
		t.Errorf("managed hook command missing:\n%s", blob)
	}

	// Cleanup removes only the managed group and keeps the user's settings.
	if _, err := captureCLI(t, "doctor", "cleanup", "--harness", "claude-code", "--yes"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	blob, err = os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(blob), "hook session-push") {
		t.Errorf("cleanup left managed hooks behind:\n%s", blob)
	}
	if !strings.Contains(string(blob), "other_setting") {
		t.Errorf("cleanup dropped user settings:\n%s", blob)
	}
}

func TestDoctorPatchDryRunWritesNothing(t *testing.T) {
	home := seededHome(t)
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	before, _ := os.ReadFile(settingsPath)

	if _, err := captureCLI(t, "doctor", "patch", "--harness", "claude-code", "--dry-run"); err != nil {
		t.Fatalf("dry-run: %v", err)
	}
	after, _ := os.ReadFile(settingsPath)
	if string(before) != string(after) {
		t.Error("dry-run must not modify the settings file")
	}
}

func TestDoctorPatchUnknownHarness(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CARACAL_SERVER_URL", "http://127.0.0.1:1")
	t.Setenv("CARACAL_ACCESS_TOKEN", "test-token")
	_, err := captureCLI(t, "doctor", "patch", "--harness", "nope")
	if err == nil {
		t.Fatal("unknown harness must fail")
	}
}

func TestDoctorPatchIsIdempotent(t *testing.T) {
	home := seededHome(t)
	settingsPath := filepath.Join(home, ".claude", "settings.json")

	if _, err := captureCLI(t, "doctor", "patch", "--harness", "claude-code"); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(settingsPath)
	if _, err := captureCLI(t, "doctor", "patch", "--harness", "claude-code"); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(settingsPath)
	if string(first) != string(second) {
		t.Errorf("second patch changed the file:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
}

// managedHookFiles walks HOME for files carrying the managed hook command.
func managedHookFiles(t *testing.T, home string) []string {
	t.Helper()
	found := []string{}
	err := filepath.Walk(home, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		blob, readErr := os.ReadFile(path)
		if readErr == nil && strings.Contains(string(blob), "hook session-push") {
			found = append(found, strings.TrimPrefix(path, home))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestDoctorPatchAllHarnessesThenCleanup(t *testing.T) {
	home := seededHome(t)

	if _, err := captureCLI(t, "doctor", "patch", "--all-harnesses"); err != nil {
		t.Fatalf("patch --all-harnesses: %v", err)
	}
	patched := managedHookFiles(t, home)
	// User-scope hook files install unconditionally; project-scope harnesses
	// only patch inside a detected project directory.
	for _, want := range []string{
		"/.claude/settings.json", "/.codex/hooks.json",
		"/.copilot/hooks/caracal.json", "/.cursor/hooks.json",
	} {
		found := false
		for _, p := range patched {
			if p == want {
				found = true
			}
		}
		if !found {
			t.Errorf("managed hooks missing from %s (have %v)", want, patched)
		}
	}

	if _, err := captureCLI(t, "doctor", "cleanup", "--yes"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if left := managedHookFiles(t, home); len(left) != 0 {
		t.Errorf("cleanup left managed hooks in %v", left)
	}
}

func TestDoctorReportsMissingHooksPerHarness(t *testing.T) {
	seededHome(t)
	out, _ := captureCLI(t, "doctor")
	for _, want := range []string{"Claude Code", "Cursor"} {
		if !strings.Contains(out, want) {
			t.Errorf("doctor output missing %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "doctor patch") {
		t.Errorf("doctor must point at the patch remediation:\n%s", out)
	}
}
