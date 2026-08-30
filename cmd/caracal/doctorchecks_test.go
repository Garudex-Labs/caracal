// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hookEntry(t *testing.T, blob string) *omap {
	t.Helper()
	value, err := decodeOrderedJSON([]byte(blob))
	if err != nil {
		t.Fatalf("decode %q: %v", blob, err)
	}
	return value.(*omap)
}

func TestIsCaracalHookEntryNeverClaimsUserHooks(t *testing.T) {
	// doctor cleanup deletes matching entries; a user's own hook must
	// never match.
	userHooks := []string{
		`{"command": "/home/me/bin/my-format-hook.sh"}`,
		`{"url": "https://hooks.example.com/notify"}`,
		`{"bash": "caracal-backup --all"}`,
		`{"command": ""}`,
	}
	for _, blob := range userHooks {
		if isCaracalHookEntry(hookEntry(t, blob)) {
			t.Errorf("user hook claimed as managed: %s", blob)
		}
	}
	if isCaracalHookEntry(nil) {
		t.Error("nil entry claimed as managed")
	}
}

func TestIsCaracalHookEntryMatchesEveryManagedGeneration(t *testing.T) {
	managed := []string{
		`{"command": "/usr/local/bin/caracal hook session-push --harness claude-code"}`,
		`{"command": "python -m caracal_cli.hooks.session_push"}`,
		`{"url": "http://localhost:8080/api/v1/telemetry/hooks"}`,
		`{"bash": "caracal-stop-hook"}`,
	}
	for _, blob := range managed {
		if !isCaracalHookEntry(hookEntry(t, blob)) {
			t.Errorf("managed hook not recognized: %s", blob)
		}
	}
}

func TestIsCaracalMatcherGroup(t *testing.T) {
	tagged := hookEntry(t, `{"_caracal": true, "hooks": []}`)
	if !isCaracalMatcherGroup(tagged) {
		t.Error("_caracal-tagged group not recognized")
	}
	nested := hookEntry(t, `{"matcher": "*", "hooks": [{"command": "caracal hook session-push"}]}`)
	if !isCaracalMatcherGroup(nested) {
		t.Error("group with a managed hook not recognized")
	}
	user := hookEntry(t, `{"matcher": "*", "hooks": [{"command": "eslint --fix"}]}`)
	if isCaracalMatcherGroup(user) {
		t.Error("user group claimed as managed")
	}
	if isCaracalMatcherGroup(nil) {
		t.Error("nil group claimed as managed")
	}
}

func TestHookCommandForTargetsTheHarness(t *testing.T) {
	got := hookCommandFor("kiro")
	if !strings.HasSuffix(got, " hook session-push --harness kiro") {
		t.Errorf("hookCommandFor = %q", got)
	}
	// The invocation itself must be recognized as managed afterwards.
	entry := newOmap()
	entry.set("command", got)
	if !isCaracalHookEntry(entry) {
		t.Errorf("generated hook command not recognized as managed: %q", got)
	}
}

func TestEventGroupsContain(t *testing.T) {
	settings := hookEntry(t, `{"hooks": {
		"Stop": [{"hooks": [{"command": "caracal hook session-push --harness claude-code"}]}],
		"PreToolUse": [{"hooks": [{"command": "eslint"}]}]
	}}`)
	if !eventGroupsContain(settings, []string{"Stop"}, "session-push") {
		t.Error("managed Stop hook not found")
	}
	if eventGroupsContain(settings, []string{"PreToolUse"}, "session-push") {
		t.Error("marker found in an event that only has user hooks")
	}
	if eventGroupsContain(settings, []string{"SessionStart"}, "session-push") {
		t.Error("marker found in an absent event")
	}
	if eventGroupsContain(hookEntry(t, `{}`), []string{"Stop"}, "session-push") {
		t.Error("marker found without a hooks block")
	}
}

func TestCopilotHookMatch(t *testing.T) {
	markers := []string{"hook session-push"}
	if !copilotHookMatch(hookEntry(t, `{"bash": "caracal hook session-push --harness copilot"}`), markers) {
		t.Error("bash-keyed managed hook not matched")
	}
	if copilotHookMatch(hookEntry(t, `{"command": "prettier --write"}`), markers) {
		t.Error("user hook matched")
	}
}

func TestLoadJSONObjectQuiet(t *testing.T) {
	dir := t.TempDir()

	if got := loadJSONObjectQuiet(filepath.Join(dir, "missing.json")); got != nil {
		t.Errorf("missing file: %v", got)
	}

	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := loadJSONObjectQuiet(bad); got != nil {
		t.Errorf("malformed file: %v", got)
	}

	// JSONC line comments (Kiro/VS Code style) must not break the parse.
	jsonc := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(jsonc, []byte("{\n  // user comment\n  \"key\": \"value\"\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := loadJSONObjectQuiet(jsonc)
	if got == nil || got.str("key") != "value" {
		t.Errorf("JSONC parse: %v", got)
	}
}
