// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package lockfile

import (
	"os"
	"path/filepath"
	"testing"
)

func setupHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := `{"server_url": "http://localhost", "access_token": "t"}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func str(s string) *string { return &s }

func TestNormalizeServerURL(t *testing.T) {
	cases := map[string]string{
		"http://Localhost:80/":               "http://localhost",
		"https://Reg.Example.com:443":        "https://reg.example.com",
		"https://reg.example.com:8443/base/": "https://reg.example.com:8443/base",
		"reg.example.com":                    "http://reg.example.com",
	}
	for in, want := range cases {
		got, err := NormalizeServerURL(in)
		if err != nil || got != want {
			t.Errorf("NormalizeServerURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := NormalizeServerURL("   "); err == nil {
		t.Error("empty URL must fail")
	}
}

func TestUpsertAndLookups(t *testing.T) {
	setupHome(t)
	if err := UpsertStandalone("kiro", Entry{
		Type: "skill", Name: "Reviewer", ID: "id-1", Version: str("1.0.0"),
		Scope: "user", Namespace: "acme", Slug: "reviewer", LocalName: "reviewer",
	}); err != nil {
		t.Fatal(err)
	}
	// Same range re-upsert replaces rather than duplicating.
	if err := UpsertStandalone("kiro", Entry{
		Type: "skill", Name: "Reviewer", ID: "id-1", Version: str("1.1.0"),
		Scope: "user", Namespace: "acme", Slug: "reviewer", LocalName: "reviewer",
	}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertAgent("kiro", Entry{
		Name: "review-bot", ID: "agent-1", Version: str("2.0.0"),
		Scope: "project", Directory: "/tmp/proj", Namespace: "acme", Slug: "review-bot",
	}); err != nil {
		t.Fatal(err)
	}

	entries, err := AllEntries("")
	if err != nil || len(entries) != 2 {
		t.Fatalf("entries = %+v err %v", entries, err)
	}
	agent, err := AgentForDirectory("kiro", "/tmp/proj")
	if err != nil || agent == nil || agent.QualifiedName != "acme/review-bot" {
		t.Fatalf("AgentForDirectory = %+v err %v", agent, err)
	}
	byID, _ := AgentByID("agent-1", "")
	if byID == nil || byID.Name != "review-bot" {
		t.Fatalf("AgentByID = %+v", byID)
	}
	byName, _ := AgentByName("review-bot", "kiro", "/tmp/proj")
	if byName == nil || byName.ID != "agent-1" {
		t.Fatalf("AgentByName = %+v", byName)
	}
	standalone, _ := AllEntries("kiro")
	for _, entry := range standalone {
		if entry.EntryType == "standalone" && (entry.Version == nil || *entry.Version != "1.1.0") {
			t.Fatalf("upsert must replace: %+v", entry)
		}
	}

	removed, err := RemoveStandalone("kiro", "skill", "id-1", "")
	if err != nil || !removed {
		t.Fatalf("remove = %v err %v", removed, err)
	}
	removedAgain, _ := RemoveStandalone("kiro", "skill", "id-1", "")
	if removedAgain {
		t.Fatal("second remove must report absence")
	}
}

func TestWorkspaceProjectBinding(t *testing.T) {
	setupHome(t)
	dir := "/tmp/acme-platform"
	if err := UpsertStandalone("claude-code", Entry{
		Type: "skill", Name: "Reviewer", ID: "id-1", Version: str("1.0.0"),
		Scope: "project", Directory: dir, Namespace: "acme", Slug: "reviewer",
		LocalName: "reviewer", Org: "acme", Project: "platform",
	}); err != nil {
		t.Fatal(err)
	}
	// The Project binding round-trips through the lockfile.
	entries, err := AllEntries("claude-code")
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %+v err %v", entries, err)
	}
	if entries[0].Org != "acme" || entries[0].Project != "platform" {
		t.Fatalf("binding lost: %+v", entries[0])
	}
	// The workspace directory resolves to its bound Project.
	org, project, ok := WorkspaceProject(dir)
	if !ok || org != "acme" || project != "platform" {
		t.Fatalf("WorkspaceProject = %q/%q ok=%v", org, project, ok)
	}
	// An unrelated directory carries no binding.
	if _, _, ok := WorkspaceProject("/tmp/other"); ok {
		t.Fatal("unbound directory must not resolve a Project")
	}
	// An empty directory never resolves.
	if _, _, ok := WorkspaceProject(""); ok {
		t.Fatal("empty directory must not resolve a Project")
	}
	// A project-scoped agent binding is detected the same way as a skill.
	agentDir := "/tmp/acme-payments"
	if err := UpsertAgent("claude-code", Entry{
		Name: "review-bot", ID: "agent-1", Version: str("2.0.0"),
		Scope: "project", Directory: agentDir, Namespace: "acme", Slug: "review-bot",
		Org: "acme", Project: "payments",
	}); err != nil {
		t.Fatal(err)
	}
	if org, project, ok := WorkspaceProject(agentDir); !ok || org != "acme" || project != "payments" {
		t.Fatalf("agent WorkspaceProject = %q/%q ok=%v", org, project, ok)
	}
}

func TestLocalRegistryNameCollisions(t *testing.T) {
	setupHome(t)
	name, err := LocalRegistryName("kiro", "skill", "acme", "reviewer", "user", "")
	if err != nil || name != "reviewer" {
		t.Fatalf("no-collision name = %q err %v", name, err)
	}
	// A same-slug entry from another namespace forces qualification.
	if err := UpsertStandalone("kiro", Entry{
		Type: "skill", Name: "Other", ID: "id-2", Version: str("1.0.0"),
		Scope: "user", Namespace: "otherns", Slug: "reviewer", LocalName: "reviewer",
	}); err != nil {
		t.Fatal(err)
	}
	name, err = LocalRegistryName("kiro", "skill", "acme", "reviewer", "user", "")
	if err != nil || name != "acme-reviewer" {
		t.Fatalf("collision name = %q err %v", name, err)
	}
}

func TestV1Migration(t *testing.T) {
	home := setupHome(t)
	v1 := `{"lock_version": 1, "harnesses": {"kiro": {"agents": [], "standalone": [{"type": "skill", "name": "Old", "id": "id-9", "version": "0.9.0", "scope": "user", "installed_at": "2026-01-01T00:00:00+00:00"}]}}}`
	if err := os.WriteFile(filepath.Join(home, ".caracal", "lockfile.json"), []byte(v1), 0o644); err != nil {
		t.Fatal(err)
	}
	data, err := Read()
	if err != nil {
		t.Fatal(err)
	}
	registry, ok := data.Registries["http://localhost"]
	if !ok || registry.Harnesses["kiro"] == nil || len(registry.Harnesses["kiro"].Standalone) != 1 {
		t.Fatalf("migrated = %+v", data)
	}
	if data.LockVersion != 2 {
		t.Fatalf("lock_version = %d", data.LockVersion)
	}
}

func TestComputeIntegrity(t *testing.T) {
	if got := ComputeIntegrity("hello"); got != "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" {
		t.Fatalf("integrity = %s", got)
	}
}
