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
	"github.com/garudex-labs/caracal/internal/cli/lockfile"
)

const syncAgentID = "cc6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d"
const syncMCPID = "dd6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d"

// writeSyncLockfile installs one agent and one standalone MCP for kiro
// under the recording server's registry key.
func writeSyncLockfile(t *testing.T, home, serverURL string) {
	t.Helper()
	registryURL, err := lockfile.NormalizeServerURL(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	version := "1.0.0"
	file := lockfile.File{
		LockVersion: lockfile.LockVersion,
		Registries: map[string]*lockfile.Registry{
			registryURL: {ServerURL: registryURL, Harnesses: map[string]*lockfile.Harness{
				"kiro": {
					Agents: []lockfile.Entry{{
						Name: "helper", ID: syncAgentID, Version: &version, Scope: "user",
						Namespace: "acme", Slug: "helper", QualifiedName: "acme/helper",
					}},
					Standalone: []lockfile.Entry{{
						Type: "mcp", Name: "weather", ID: syncMCPID, Version: &version, Scope: "user",
						Namespace: "acme", Slug: "weather", QualifiedName: "acme/weather",
					}},
				},
			}},
		},
	}
	blob, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, ".caracal")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "lockfile.json"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSyncDryRunPlansOnlyOutdatedItems(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + syncAgentID: {body: `{"latest_approved_version": "2.0.0", "namespace": "acme", "slug": "helper"}`},
		"GET /api/v1/mcps/" + syncMCPID:     {body: `{"version": "1.0.0", "namespace": "acme", "slug": "weather"}`},
	})
	home := recEnv(t, rec)
	writeSyncLockfile(t, home, rec.srv.URL)

	out, err := captureCLI(t, "sync", "--dry-run", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		DryRun   bool `json:"dry_run"`
		UpToDate int  `json:"up_to_date"`
		Planned  int  `json:"planned"`
		Applied  []struct {
			Target  string `json:"target"`
			Command string `json:"command"`
		} `json:"applied"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("sync output not JSON: %v\n%s", err, out)
	}
	if !doc.DryRun || doc.Planned != 1 || doc.UpToDate != 1 {
		t.Errorf("plan = %+v", doc)
	}
	if len(doc.Applied) != 1 || doc.Applied[0].Target != "acme/helper@kiro" ||
		doc.Applied[0].Command != "caracal agent pull acme/helper --harness kiro --no-prompt" {
		t.Errorf("planned action = %+v", doc.Applied)
	}
	// A dry run must never mutate anything.
	for _, line := range rec.lines() {
		if strings.HasPrefix(line, "POST") || strings.HasPrefix(line, "PUT") || strings.HasPrefix(line, "DELETE") {
			t.Errorf("dry run issued a write: %s", line)
		}
	}
}

func TestSyncWithoutLockfileIsCleanNoop(t *testing.T) {
	srv := fakeAPI(t, nil)
	out, err := runCLI(t, srv, "sync")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Everything is up to date") {
		t.Errorf("empty sync output:\n%s", out)
	}
}

func TestSyncStaleOrgContextFailsBeforeActing(t *testing.T) {
	rec := newRecordingAPI(t, nil)
	home := recEnv(t, rec)
	writeSyncLockfile(t, home, rec.srv.URL)
	root := newRootCommand()
	root.SetArgs([]string{"config", "set", "default_org", "ghost"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}

	_, err := captureCLI(t, "sync", "--dry-run")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.NotFound {
		t.Errorf("stale org category = %s", cerr.Category)
	}
	if !strings.Contains(cerr.Remediation, "caracal use") {
		t.Errorf("remediation must point at caracal use: %s", cerr.Remediation)
	}
	// No registry item may be consulted with an invalid tenant context.
	for _, line := range rec.lines() {
		if strings.Contains(line, "/api/v1/agents/") || strings.Contains(line, "/api/v1/mcps/") {
			t.Errorf("sync consulted the registry despite a stale context: %s", line)
		}
	}
}

func TestSyncArgsPerItemType(t *testing.T) {
	agent := outdatedItem{Type: "agent", QualifiedName: "acme/helper", Harness: "kiro"}
	if got := strings.Join(syncArgs(agent), " "); got != "agent pull acme/helper --harness kiro --no-prompt" {
		t.Errorf("agent args = %q", got)
	}
	mcp := outdatedItem{Type: "mcp", QualifiedName: "acme/weather", Harness: "kiro"}
	if got := strings.Join(syncArgs(mcp), " "); got != "registry mcp install acme/weather --harness kiro --no-prompt" {
		t.Errorf("mcp args = %q", got)
	}
	skill := outdatedItem{Type: "skill", QualifiedName: "acme/reviewer", Harness: "claude-code"}
	if got := strings.Join(syncArgs(skill), " "); got != "registry skill install acme/reviewer --harness claude-code" {
		t.Errorf("skill args = %q", got)
	}
}
