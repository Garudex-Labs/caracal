// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestTimeoutCoercions(t *testing.T) {
	cases := []struct {
		name string
		cfg  map[string]any
		want int
	}{
		{"int value", map[string]any{"timeout": 45}, 45},
		{"float from JSON", map[string]any{"timeout": float64(90)}, 90},
		{"zero falls back", map[string]any{"timeout": 0}, 30},
		{"negative falls back", map[string]any{"timeout": float64(-5)}, 30},
		{"non-numeric falls back", map[string]any{"timeout": "60"}, 30},
		{"missing falls back", map[string]any{}, 30},
	}
	for _, tc := range cases {
		if got := Timeout(tc.cfg); got != tc.want {
			t.Errorf("%s: Timeout = %d, want %d", tc.name, got, tc.want)
		}
	}
}

func TestStrFallsBackToEmpty(t *testing.T) {
	cfg := map[string]any{"server_url": "http://localhost", "timeout": 30}
	if got := Str(cfg, "server_url"); got != "http://localhost" {
		t.Errorf("Str(server_url) = %q", got)
	}
	if got := Str(cfg, "timeout"); got != "" {
		t.Errorf("Str on non-string = %q, want empty", got)
	}
	if got := Str(cfg, "absent"); got != "" {
		t.Errorf("Str on missing key = %q, want empty", got)
	}
}

func TestAlternateTokenVariablesOverrideAccessToken(t *testing.T) {
	for _, name := range []string{"CARACAL_TOKEN"} {
		t.Run(name, func(t *testing.T) {
			withTempHome(t)
			t.Setenv(name, "alt-token")
			cfg, cerr := Load()
			if cerr != nil {
				t.Fatal(cerr)
			}
			if cfg["access_token"] != "alt-token" {
				t.Fatalf("access_token = %v", cfg["access_token"])
			}
		})
	}
}

func TestAPIKeyEnvironmentDoesNotAuthenticate(t *testing.T) {
	withTempHome(t)
	t.Setenv("CARACAL_API_KEY", "legacy-key")
	cfg, cerr := Load()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if got := cfg["access_token"]; got != "" {
		t.Fatalf("access_token = %v, want empty", got)
	}
}

func TestLoadPersistedStripsDisplayKeys(t *testing.T) {
	home := withTempHome(t)
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	blob := `{"server_url": "http://localhost", "output": "json", "color": "never"}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(blob), 0o600); err != nil {
		t.Fatal(err)
	}
	persisted, cerr := LoadPersisted()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if persisted["server_url"] != "http://localhost" {
		t.Fatalf("persisted = %v", persisted)
	}
	if _, ok := persisted["output"]; ok {
		t.Error("output must be stripped from persisted config")
	}
	if _, ok := persisted["color"]; ok {
		t.Error("color must be stripped from persisted config")
	}
}

func TestUnreadableConfigReportsUnexpected(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	home := withTempHome(t)
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
	_, cerr := Load()
	if cerr == nil || cerr.Category != clierr.Unexpected || cerr.ExitCode() != 1 {
		t.Fatalf("want unexpected exit 1, got %v", cerr)
	}
}

func TestSaveIntoReadOnlyHomeReportsPermission(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	home := withTempHome(t)
	if err := os.Chmod(home, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(home, 0o755) })
	cerr := Save(map[string]any{"server_url": "http://localhost"})
	if cerr == nil || cerr.Category != clierr.Permission || cerr.ExitCode() != 4 {
		t.Fatalf("want permission exit 4, got %v", cerr)
	}
	if cerr.Remediation == "" {
		t.Error("permission failure must carry a remediation")
	}
}
