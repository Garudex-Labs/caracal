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

// ── self helpers (no network) ──────────────────────────────────────

func TestDetectInstallClassifiesRunningBinary(t *testing.T) {
	install := detectInstall()
	if install.Path == "" {
		t.Error("install path must be resolved")
	}
	switch install.Method {
	case "homebrew", "system", "binary":
	default:
		t.Errorf("unexpected install method: %q", install.Method)
	}
}

func TestSelfArtifactNameMatchesRuntime(t *testing.T) {
	name, cerr := selfArtifactName()
	if cerr != nil {
		t.Fatalf("artifact name failed for this platform: %v", cerr)
	}
	if !strings.HasPrefix(name, "caracal-") {
		t.Errorf("artifact name = %q", name)
	}
}

func TestManagedInstallGuardBlocksPackageManagers(t *testing.T) {
	brew := managedInstallGuard(installInfo{Method: "homebrew", ManagedBy: "brew"}, "Upgrade Caracal CLI")
	if brew == nil || brew.Category != clierr.Conflict {
		t.Fatalf("homebrew install must be guarded: %v", brew)
	}
	if !strings.Contains(brew.Remediation, "brew") {
		t.Errorf("remediation must name the manager: %s", brew.Remediation)
	}
	if managedInstallGuard(installInfo{Method: "binary"}, "Upgrade Caracal CLI") != nil {
		t.Error("standalone binaries must not be guarded")
	}
}

func TestVersionNewerComparesReleases(t *testing.T) {
	if newer, err := versionNewer("2.0.0", "1.9.9"); err != nil || !newer {
		t.Errorf("2.0.0 > 1.9.9: %v %v", newer, err)
	}
	if newer, err := versionNewer("1.0.0", "1.0.0"); err != nil || newer {
		t.Errorf("equal versions are not newer: %v %v", newer, err)
	}
	if _, err := versionNewer("not-a-version", "1.0.0"); err == nil {
		t.Error("malformed versions must error")
	}
}

// ── self upgrade (validation paths, no network) ────────────────────

func TestSelfUpgradeRejectsInvalidVersionLocally(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "self", "upgrade", "--version", "not-a-version")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "not-a-version") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestSelfUpgradeJSONModeRefusesToPrompt(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// A concrete newer target skips the GitHub lookup; JSON mode must still
	// refuse to run without an explicit --force confirmation.
	_, err := captureCLI(t, "self", "upgrade", "--version", "9.9.9", "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "cannot prompt") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "--force") {
		t.Errorf("remediation must mention --force: %s", cerr.Remediation)
	}
}

func TestSelfUpgradeAlreadyOnTargetReportsUpToDate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	out, err := captureCLI(t, "self", "upgrade", "--version", cliVersion, "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Action string `json:"action"`
		Status string `json:"status"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.Status != "up_to_date" {
		t.Errorf("up-to-date document: %s", out)
	}
}

func TestSelfUpgradeOlderTargetIsRedirectedToDowngrade(t *testing.T) {
	orig := cliVersion
	cliVersion = "2.0.0"
	defer func() { cliVersion = orig }()
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "self", "upgrade", "--version", "1.5.0", "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Remediation, "downgrade") {
		t.Errorf("older target must point at downgrade: %s / %s", cerr.Message, cerr.Remediation)
	}
}

// ── self downgrade (validation paths, no network) ──────────────────

func TestSelfDowngradeRejectsListAndVersionTogether(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "self", "downgrade", "--list", "--version", "1.0.0")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "either") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestSelfDowngradeRequiresTarget(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "self", "downgrade")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "target version is required") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestSelfDowngradeRejectsInvalidVersion(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "self", "downgrade", "--version", "bogus")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "Invalid target version") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestSelfDowngradeRejectsBelowFloor(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "self", "downgrade", "--version", "0.5.0")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "below v1.0.0") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestSelfDowngradeRejectsNonOlderTarget(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// cliVersion is 0.0.0 in tests, so any release floor target is "not older".
	_, err := captureCLI(t, "self", "downgrade", "--version", "9.9.9")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "not older") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestSelfDowngradeJSONModeRefusesToPrompt(t *testing.T) {
	orig := cliVersion
	cliVersion = "2.0.0"
	defer func() { cliVersion = orig }()
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "self", "downgrade", "--version", "1.5.0", "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "cannot prompt") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

// ── self rollback (validation paths, no network) ───────────────────

func TestSelfRollbackWithoutBackupIsNotFound(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "self", "rollback")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.NotFound || !strings.Contains(cerr.Message, "backup") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "upgrade or downgrade") {
		t.Errorf("remediation must explain how a backup appears: %s", cerr.Remediation)
	}
}

func TestSelfRollbackJSONModeRefusesToPrompt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// A stored backup unlocks the rollback; JSON mode still needs --force.
	backup := filepath.Join(home, ".caracal", "bin", "caracal.prev")
	if err := os.MkdirAll(filepath.Dir(backup), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, []byte("previous-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := captureCLI(t, "self", "rollback", "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "cannot prompt") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}
