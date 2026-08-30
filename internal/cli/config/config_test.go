// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"os"
	"path/filepath"
	"testing"
)

func withTempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func TestLoadDefaultsWhenNoFile(t *testing.T) {
	withTempHome(t)
	cfg, cerr := Load()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if cfg["server_url"] != "" || cfg["timeout"] != 30 || cfg["update_check"] != true {
		t.Fatalf("defaults wrong: %v", cfg)
	}
}

func TestSaveRoundTripAndPermissions(t *testing.T) {
	home := withTempHome(t)
	if cerr := Save(map[string]any{"server_url": "http://localhost", "timeout": 60}); cerr != nil {
		t.Fatal(cerr)
	}
	info, err := os.Stat(filepath.Join(home, ".caracal", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
	cfg, cerr := Load()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if cfg["server_url"] != "http://localhost" {
		t.Errorf("server_url = %v", cfg["server_url"])
	}
	if cerr := Remove("server_url"); cerr != nil {
		t.Fatal(cerr)
	}
	cfg, _ = Load()
	if cfg["server_url"] != "" {
		t.Errorf("after remove server_url = %v", cfg["server_url"])
	}
}

func TestEnvironmentOverrides(t *testing.T) {
	withTempHome(t)
	t.Setenv("CARACAL_SERVER_URL", "http://env-server")
	t.Setenv("CARACAL_ACCESS_TOKEN", "env-token")
	cfg, cerr := Load()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if cfg["server_url"] != "http://env-server" || cfg["access_token"] != "env-token" {
		t.Fatalf("overrides not applied: %v", cfg)
	}
}

func TestSecretFileResolution(t *testing.T) {
	home := withTempHome(t)
	secret := filepath.Join(home, "token.txt")
	if err := os.WriteFile(secret, []byte("file-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_ACCESS_TOKEN_FILE", secret)
	cfg, cerr := Load()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if cfg["access_token"] != "file-token" {
		t.Errorf("access_token = %v", cfg["access_token"])
	}
}

func TestConflictingSecretDefinitionsFail(t *testing.T) {
	withTempHome(t)
	t.Setenv("CARACAL_ACCESS_TOKEN", "a")
	t.Setenv("CARACAL_ACCESS_TOKEN_FILE", "/nonexistent")
	_, cerr := Load()
	if cerr == nil || cerr.ExitCode() != 7 {
		t.Fatalf("want validation failure, got %v", cerr)
	}
}

func TestMalformedConfigFails(t *testing.T) {
	home := withTempHome(t)
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, cerr := Load()
	if cerr == nil || cerr.ExitCode() != 7 {
		t.Fatalf("want validation exit 7, got %v", cerr)
	}
}
