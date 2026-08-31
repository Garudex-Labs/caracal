// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Pruning removes only the named managed server and never a developer-owned or
// still-managed entry, across JSON, YAML, and TOML harness configs.
func TestPruneMcpEntries(t *testing.T) {
	t.Run("json", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "mcp.json")
		write(t, path, `{
  "mcpServers": {
    "managed-stale": {"command": "npx"},
    "managed-keep": {"command": "uvx"},
    "developer-owned": {"command": "node"}
  }
}
`)
		if err := pruneMcpEntries(path, "mcpServers", map[string]bool{"managed-stale": true}); err != nil {
			t.Fatal(err)
		}
		got := read(t, path)
		if strings.Contains(got, "managed-stale") {
			t.Errorf("stale entry not removed:\n%s", got)
		}
		for _, keep := range []string{"managed-keep", "developer-owned"} {
			if !strings.Contains(got, keep) {
				t.Errorf("%s was removed unexpectedly:\n%s", keep, got)
			}
		}
	})

	t.Run("yaml", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "goose.yaml")
		write(t, path, "extensions:\n  managed-stale:\n    cmd: npx\n  developer-owned:\n    cmd: node\n")
		if err := pruneMcpEntries(path, "extensions", map[string]bool{"managed-stale": true}); err != nil {
			t.Fatal(err)
		}
		got := read(t, path)
		if strings.Contains(got, "managed-stale") {
			t.Errorf("stale entry not removed:\n%s", got)
		}
		if !strings.Contains(got, "developer-owned") {
			t.Errorf("developer entry removed:\n%s", got)
		}
	})

	t.Run("toml", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.toml")
		write(t, path, "[mcp_servers.managed-stale]\ncommand = \"npx\"\n\n[mcp_servers.developer-owned]\ncommand = \"node\"\n")
		if err := pruneMcpEntries(path, "mcp_servers", map[string]bool{"managed-stale": true}); err != nil {
			t.Fatal(err)
		}
		got := read(t, path)
		if strings.Contains(got, "managed-stale") {
			t.Errorf("stale table not removed:\n%s", got)
		}
		if !strings.Contains(got, "[mcp_servers.developer-owned]") || !strings.Contains(got, `command = "node"`) {
			t.Errorf("developer table damaged:\n%s", got)
		}
	})

	t.Run("missing file is a no-op", func(t *testing.T) {
		if err := pruneMcpEntries(filepath.Join(t.TempDir(), "absent.json"), "mcpServers", map[string]bool{"x": true}); err != nil {
			t.Fatalf("missing file must be a no-op, got %v", err)
		}
	})

	t.Run("absent name leaves the file untouched", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "mcp.json")
		original := "{\n  \"mcpServers\": {\n    \"only\": {\n      \"command\": \"npx\"\n    }\n  }\n}\n"
		write(t, path, original)
		if err := pruneMcpEntries(path, "mcpServers", map[string]bool{"not-present": true}); err != nil {
			t.Fatal(err)
		}
		if read(t, path) != original {
			t.Errorf("file changed for an absent name:\n%s", read(t, path))
		}
	})
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(blob)
}
