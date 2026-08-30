// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// TestDoctorDiagnoseReportsEveryDetectedHarness seeds a marker for each
// remaining harness so the per-harness checks reach their "detected but
// hooks missing" branch. No server env is set, so the network lockfile
// reconciliation step is skipped (api.New fails the auth contract first).
func TestDoctorDiagnoseReportsEveryDetectedHarness(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedFile(t, filepath.Join(home, ".codex", "config.toml"), "# codex config\n")
	seedFile(t, filepath.Join(home, ".vscode", "mcp.json"), `{}`)
	seedFile(t, filepath.Join(home, ".copilot", "mcp-config.json"), `{}`)
	seedFile(t, filepath.Join(home, ".config", "opencode", "opencode.json"), `{}`)
	seedFile(t, filepath.Join(home, ".gemini", "config", "mcp_config.json"), `{}`)
	seedFile(t, filepath.Join(home, ".config", "goose", "config.yaml"), "extensions: {}\n")

	out, err := captureCLI(t, "doctor", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Warnings []string `json:"warnings"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("doctor output is not JSON:\n%s", out)
	}
	joined := strings.Join(doc.Warnings, "\n")
	// Every warning here is home-scoped and therefore hermetic. The Copilot
	// (VS Code) check is intentionally omitted: it also inspects the real
	// working tree (cwd/.github/hooks), which sibling tests patch.
	for _, want := range []string{
		"Codex session push",
		"Copilot CLI session push",
		"OpenCode caracal plugin not installed",
		"Antigravity session push",
		"Goose session push",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("doctor diagnose missing warning %q:\n%s", want, joined)
		}
	}
}

// TestDoctorPatchThenDiagnoseClearsWarning verifies a single-harness patch
// silences that harness's diagnose warning for the remaining harnesses that
// the existing suite does not exercise end to end.
func TestDoctorPatchThenDiagnoseClearsCodexWarning(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Patch requires configured auth; an unreachable server is sufficient
	// because the hook files are written locally.
	t.Setenv("CARACAL_SERVER_URL", "http://127.0.0.1:1")
	t.Setenv("CARACAL_ACCESS_TOKEN", "test-token")
	seedFile(t, filepath.Join(home, ".codex", "config.toml"), "# codex config\n")

	if _, err := captureCLI(t, "doctor", "patch", "--harness", "codex"); err != nil {
		t.Fatalf("patch codex: %v", err)
	}
	out, err := captureCLI(t, "doctor", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Warnings []string `json:"warnings"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("doctor output is not JSON:\n%s", out)
	}
	for _, warning := range doc.Warnings {
		if strings.Contains(warning, "Codex session push") {
			t.Errorf("codex warning must clear after patch: %q", warning)
		}
	}
}
