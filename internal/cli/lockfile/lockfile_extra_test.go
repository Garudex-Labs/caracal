// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package lockfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateV1ExplicitServerURL(t *testing.T) {
	home := setupHome(t)
	v1 := `{"lock_version": 1, "harnesses": {"kiro": {"agents": [], "standalone": [{"type": "skill", "name": "Old", "id": "id-9", "version": "0.9.0", "scope": "user"}]}}}`
	if err := os.WriteFile(filepath.Join(home, ".caracal", "lockfile.json"), []byte(v1), 0o644); err != nil {
		t.Fatal(err)
	}
	// The explicit URL wins over the configured http://localhost server.
	if err := MigrateV1("https://Other.Example.com:443/"); err != nil {
		t.Fatal(err)
	}
	data, err := Read()
	if err != nil {
		t.Fatal(err)
	}
	registry, ok := data.Registries["https://other.example.com"]
	if !ok || registry.Harnesses["kiro"] == nil || len(registry.Harnesses["kiro"].Standalone) != 1 {
		t.Fatalf("migrated = %+v", data)
	}
	if _, ok := data.Registries["http://localhost"]; ok {
		t.Fatal("configured server must not claim an explicitly re-homed lockfile")
	}
}

func TestRemoveAgentScopedByDirectory(t *testing.T) {
	setupHome(t)
	for _, dir := range []string{"/tmp/proj-a", "/tmp/proj-b"} {
		if err := UpsertAgent("kiro", Entry{
			Name: "bot", ID: "agent-1", Version: str("1.0.0"),
			Scope: "project", Directory: dir, Namespace: "acme", Slug: "bot",
		}); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := RemoveAgent("kiro", "agent-1", "/tmp/does-not-exist")
	if err != nil || removed {
		t.Fatalf("mismatched directory removed = %v err %v", removed, err)
	}
	removed, err = RemoveAgent("kiro", "agent-1", "/tmp/proj-a")
	if err != nil || !removed {
		t.Fatalf("remove = %v err %v", removed, err)
	}
	// The other project install survives, and an empty directory matches it.
	remaining, err := AgentForDirectory("kiro", "/tmp/proj-b")
	if err != nil || remaining == nil {
		t.Fatalf("remaining = %+v err %v", remaining, err)
	}
	removed, err = RemoveAgent("kiro", "agent-1", "")
	if err != nil || !removed {
		t.Fatalf("unscoped remove = %v err %v", removed, err)
	}
	removed, _ = RemoveAgent("kiro", "agent-1", "")
	if removed {
		t.Fatal("removing an absent agent must report absence")
	}
}

func TestUpsertAgentReplacesUserScopedEntry(t *testing.T) {
	setupHome(t)
	for _, version := range []string{"1.0.0", "2.0.0"} {
		if err := UpsertAgent("kiro", Entry{
			Name: "bot", ID: "agent-1", Version: str(version), Scope: "user",
		}); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := AllEntries("kiro")
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %+v err %v", entries, err)
	}
	if entries[0].Version == nil || *entries[0].Version != "2.0.0" {
		t.Fatalf("upsert must replace: %+v", entries[0])
	}
}

func TestAgentForSessionResolution(t *testing.T) {
	setupHome(t)
	if err := UpsertAgent("kiro", Entry{
		Name: "bot", ID: "agent-user", Scope: "user", Version: str("1.0.0"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertAgent("cursor", Entry{
		Name: "bot", ID: "agent-proj", Scope: "project", Directory: "/tmp/p1", Version: str("1.0.0"),
	}); err != nil {
		t.Fatal(err)
	}

	// Directory plus name wins outright, across harnesses.
	agent, err := AgentForSession("/tmp/p1", "bot")
	if err != nil || agent == nil || agent.ID != "agent-proj" {
		t.Fatalf("dir+name = %+v err %v", agent, err)
	}
	// Name only prefers the user-scoped install.
	agent, err = AgentForSession("", "bot")
	if err != nil || agent == nil || agent.ID != "agent-user" {
		t.Fatalf("name-only = %+v err %v", agent, err)
	}
	// No name: the first directory match wins.
	agent, err = AgentForSession("/tmp/p1", "")
	if err != nil || agent == nil || agent.ID != "agent-proj" {
		t.Fatalf("dir-only = %+v err %v", agent, err)
	}
	// The identity also matches as a name.
	agent, err = AgentForSession("", "agent-proj")
	if err != nil || agent == nil || agent.ID != "agent-proj" {
		t.Fatalf("by-id = %+v err %v", agent, err)
	}
	agent, err = AgentForSession("/nope", "zzz")
	if err != nil || agent != nil {
		t.Fatalf("no match = %+v err %v", agent, err)
	}
}

func TestAgentByNameAmbiguityFailsClosed(t *testing.T) {
	setupHome(t)
	for _, dir := range []string{"/tmp/p1", "/tmp/p2"} {
		if err := UpsertAgent("kiro", Entry{
			Name: "bot", ID: "agent-" + filepath.Base(dir), Scope: "project", Directory: dir,
			LocalName: "acme-bot-" + filepath.Base(dir), Version: str("1.0.0"),
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Two project installs of the same name without a directory are ambiguous.
	agent, err := AgentByName("bot", "kiro", "")
	if err != nil || agent != nil {
		t.Fatalf("ambiguous lookup = %+v err %v", agent, err)
	}
	// The directory disambiguates.
	agent, err = AgentByName("bot", "kiro", "/tmp/p2")
	if err != nil || agent == nil || agent.ID != "agent-p2" {
		t.Fatalf("directory lookup = %+v err %v", agent, err)
	}
	// The local registry name resolves too.
	agent, err = AgentByName("acme-bot-p1", "kiro", "")
	if err != nil || agent == nil || agent.ID != "agent-p1" {
		t.Fatalf("local-name lookup = %+v err %v", agent, err)
	}
	// An unknown harness has no section.
	agent, err = AgentByName("bot", "goose", "")
	if err != nil || agent != nil {
		t.Fatalf("unknown harness = %+v err %v", agent, err)
	}
}

func TestReadRejectsUnsupportedVersion(t *testing.T) {
	home := setupHome(t)
	path := filepath.Join(home, ".caracal", "lockfile.json")
	if err := os.WriteFile(path, []byte(`{"lock_version": 5, "registries": {}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(); err == nil {
		t.Fatal("unsupported lock_version must fail")
	}
	if err := os.WriteFile(path, []byte("{nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(); err == nil {
		t.Fatal("malformed lockfile must fail")
	}
}
