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

// ── config ─────────────────────────────────────────────────────────

func TestConfigShowJSONHidesCredentialValues(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := captureCLI(t, "config", "set", "timeout", "45"); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLI(t, "config", "show", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("show output is not JSON:\n%s", out)
	}
	if doc["timeout"] != float64(45) {
		t.Errorf("timeout = %v", doc["timeout"])
	}
	if doc["access_token_configured"] != false {
		t.Errorf("credentials must appear only as presence flags: %v", doc)
	}
	for key := range doc {
		if strings.Contains(key, "token") && !strings.HasSuffix(key, "_configured") {
			t.Errorf("raw credential key leaked: %s", key)
		}
	}
}

func TestConfigSetRejectsUnknownKey(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "config", "set", "access_token", "sneaky")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "access_token") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "server_url") {
		t.Errorf("remediation must list settable keys: %s", cerr.Remediation)
	}
}

func TestConfigSetValidatesValues(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cases := []struct {
		key, value, wantIn string
	}{
		{"timeout", "abc", "at least 1"},
		{"timeout", "0", "at least 1"},
		{"update_check_interval", "30", "at least 60"},
		{"update_check", "maybe", "boolean"},
		{"server_url", "ftp://example.com", "HTTP or HTTPS"},
		{"server_url", "https://user:pw@example.com", "HTTP or HTTPS"},
	}
	for _, tc := range cases {
		_, err := captureCLI(t, "config", "set", tc.key, tc.value)
		cerr := asCLIError(t, err)
		if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, tc.wantIn) {
			t.Errorf("set %s %s: got %s: %s", tc.key, tc.value, cerr.Category, cerr.Message)
		}
	}
}

func TestConfigSetNormalizesValues(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	out, err := captureCLI(t, "config", "set", "server_url", "https://caracal.example.com/", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc configSetDocument
	if json.Unmarshal([]byte(out), &doc) != nil {
		t.Fatalf("set output is not JSON:\n%s", out)
	}
	if doc.Value != "https://caracal.example.com" || doc.Persisted != true {
		t.Errorf("trailing slash must be trimmed: %+v", doc)
	}
	out2, err := captureCLI(t, "config", "set", "update_check", "off", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal([]byte(out2), &doc) != nil || doc.Value != false {
		t.Errorf("off must normalize to false: %+v", doc)
	}
}

// ── api ────────────────────────────────────────────────────────────

func TestAPICommandPostsBodyAndQueryParams(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"POST /api/v1/widgets": {status: 201, body: `{"id": "w-1", "name": "spinner"}`},
	})
	home := recEnv(t, rec)
	bodyFile := filepath.Join(home, "body.json")
	if err := os.WriteFile(bodyFile, []byte(`{"name": "spinner"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := captureCLI(t, "api", "post", "/api/v1/widgets",
		"-f", bodyFile, "--param", "dry_run=true", "--param", "scope=all", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		ID string `json:"id"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.ID != "w-1" {
		t.Errorf("response passthrough:\n%s", out)
	}
	req, ok := rec.find("POST", "/api/v1/widgets")
	if !ok {
		t.Fatalf("no request recorded: %v", rec.lines())
	}
	if !strings.Contains(req.Body, `"name":"spinner"`) {
		t.Errorf("body = %s", req.Body)
	}
	if !strings.Contains(req.Query, "dry_run=true") || !strings.Contains(req.Query, "scope=all") {
		t.Errorf("query = %s", req.Query)
	}
}

func TestAPICommandSurfacesServerErrors(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/widgets": {status: 403, body: `{"detail": "admin only"}`},
	})
	_, err := runCLI(t, srv, "api", "get", "/api/v1/widgets")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Permission || !strings.Contains(cerr.Message, "admin only") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestAPICommandRejectsUnknownMethodLocally(t *testing.T) {
	_, err := runCLI(t, nil, "api", "brew", "/api/v1/widgets")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "brew") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestAPICommandRejectsNonV1PathLocally(t *testing.T) {
	_, err := runCLI(t, nil, "api", "get", "/admin/users")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "/api/v1/") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestAPICommandRejectsMalformedParamLocally(t *testing.T) {
	_, err := runCLI(t, nil, "api", "get", "/api/v1/widgets", "--param", "novalue")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "novalue") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestAPICommandRejectsUnreadableBodyFile(t *testing.T) {
	_, err := runCLI(t, nil, "api", "post", "/api/v1/widgets", "-f", "/nonexistent/body.json")
	if asCLIError(t, err).Category != clierr.Validation {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}

// ── bundled skill sync (doctor auto-fix) ───────────────────────────

func TestDoctorAutoFixInstallsBundledSkills(t *testing.T) {
	home := seededHome(t)
	out, err := captureCLI(t, "doctor", "--yes", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		FixAttempted bool     `json:"fix_attempted"`
		SkillMissing []string `json:"skill_missing"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || !doc.FixAttempted {
		t.Errorf("doctor --yes must attempt the fix:\n%.400s", out)
	}
	if !contains(doc.SkillMissing, "Claude Code") {
		t.Errorf("seeded home must report the missing skill: %v", doc.SkillMissing)
	}
	// The fix mirrors every bundled skill into each detected harness dir.
	for _, skill := range []string{"caracal", "caracal-agents", "caracal-registry", "caracal-ops", "caracal-advanced"} {
		for _, harnessDir := range []string{".claude", ".kiro", ".cursor"} {
			path := filepath.Join(home, harnessDir, "skills", skill, "SKILL.md")
			if _, statErr := os.Stat(path); statErr != nil {
				t.Errorf("skill not installed: %s", path)
			}
		}
	}
}

func TestSyncBundledSkillsHonorsHarnessMarkers(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".claude", "settings.json"), `{}`)
	updated := syncBundledSkills(home, true)
	if !contains(updated, "Claude Code") {
		t.Errorf("updated = %v", updated)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "skills", "caracal", "SKILL.md")); err != nil {
		t.Errorf("skill must be installed for the detected harness: %v", err)
	}
	// No marker for copilot-cli, so nothing may be written there.
	if _, err := os.Stat(filepath.Join(home, ".copilot", "skills")); !os.IsNotExist(err) {
		t.Errorf("undetected harness must not receive skills (err=%v)", err)
	}
}

func TestSyncBundledSkillsRefreshesDriftedContent(t *testing.T) {
	home := t.TempDir()
	seedFile(t, filepath.Join(home, ".claude", "settings.json"), `{}`)
	if updated := syncBundledSkills(home, true); len(updated) == 0 {
		t.Fatal("first sync must install")
	}
	skillPath := filepath.Join(home, ".claude", "skills", "caracal", "SKILL.md")
	if err := os.WriteFile(skillPath, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	// installMissing=false still repairs files that already exist.
	if updated := syncBundledSkills(home, false); !contains(updated, "Claude Code") {
		t.Errorf("drift must be repaired: %v", updated)
	}
	blob, _ := os.ReadFile(skillPath)
	if string(blob) == "tampered" {
		t.Error("skill content must be restored from the embedded copy")
	}
	// A clean second pass reports no changes.
	if updated := syncBundledSkills(home, true); len(updated) != 0 {
		t.Errorf("idempotent sync must report nothing: %v", updated)
	}
}
