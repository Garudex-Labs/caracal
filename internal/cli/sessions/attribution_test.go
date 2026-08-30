// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/lockfile"
)

func attributionHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CARACAL_AGENT_ID", "")
	t.Setenv("CARACAL_AGENT_NAME", "")
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

func installAgent(t *testing.T, harness string, entry lockfile.Entry) {
	t.Helper()
	if err := lockfile.UpsertAgent(harness, entry); err != nil {
		t.Fatal(err)
	}
}

func version(s string) *string { return &s }

func writeKiroSession(t *testing.T, dir, sessionID string, session string) string {
	t.Helper()
	jsonlPath := filepath.Join(dir, sessionID+".jsonl")
	if err := os.WriteFile(jsonlPath, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sessionID+".json"), []byte(session), 0o600); err != nil {
		t.Fatal(err)
	}
	return jsonlPath
}

func TestKiroSessionAgentVersionFromLockfile(t *testing.T) {
	attributionHome(t)
	installAgent(t, "kiro", lockfile.Entry{
		Name: "review-bot", ID: "agent-1", Version: version("2.0.0"),
		Scope: "project", Directory: "/tmp/proj",
	})
	jsonlPath := writeKiroSession(t, t.TempDir(), "s1",
		`{"cwd": "/tmp/proj", "session_state": {"agent_name": "review-bot"}}`)

	id, ver := ResolveAgent("kiro", "/tmp/proj", jsonlPath, nil)
	if id != "agent-1" || ver != "2.0.0" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestKiroSessionWithoutLockfileStaysUnattributed(t *testing.T) {
	attributionHome(t)
	jsonlPath := writeKiroSession(t, t.TempDir(), "s1",
		`{"session_state": {"agent_name": "review-bot"}}`)

	id, ver := ResolveAgent("kiro", "/tmp/proj", jsonlPath, nil)
	if id != nil || ver != nil {
		t.Fatalf("ResolveAgent = %v, %v; want unattributed", id, ver)
	}
}

func TestKiroDefaultAgentStaysUnattributed(t *testing.T) {
	attributionHome(t)
	installAgent(t, "kiro", lockfile.Entry{
		Name: "kiro_default", ID: "agent-1", Version: version("2.0.0"),
		Scope: "project", Directory: "/tmp/proj",
	})
	jsonlPath := writeKiroSession(t, t.TempDir(), "s1",
		`{"session_state": {"agent_name": "kiro_default"}}`)

	id, ver := ResolveAgent("kiro", "/tmp/proj", jsonlPath, nil)
	if id != nil || ver != nil {
		t.Fatalf("ResolveAgent = %v, %v; want unattributed", id, ver)
	}
}

func TestKiroNeverTrustsHookEnvironment(t *testing.T) {
	attributionHome(t)
	installAgent(t, "kiro", lockfile.Entry{
		Name: "review-bot", ID: "agent-1", Version: version("2.0.0"),
		Scope: "project", Directory: "/tmp/proj",
	})
	t.Setenv("CARACAL_AGENT_ID", "agent-1")
	jsonlPath := writeKiroSession(t, t.TempDir(), "s1", `{"session_state": {}}`)

	id, ver := ResolveAgent("kiro", "/tmp/proj", jsonlPath, nil)
	if id != nil || ver != nil {
		t.Fatalf("ResolveAgent = %v, %v; kiro identity must come from session metadata", id, ver)
	}
}

func TestKiroLatestUserTurnFallback(t *testing.T) {
	attributionHome(t)
	installAgent(t, "kiro", lockfile.Entry{
		Name: "review-bot", ID: "agent-1", Version: version("2.0.0"),
		Scope: "project", Directory: "/tmp/proj",
	})
	jsonlPath := writeKiroSession(t, t.TempDir(), "s1",
		`{"session_state": {"conversation_metadata": {"user_turn_metadatas": [
			{"loop_id": {"agent_id": {"name": "old-agent"}}},
			{"loop_id": {"agent_id": {"name": "review-bot"}}}
		]}}}`)

	id, ver := ResolveAgent("kiro", "/tmp/proj", jsonlPath, nil)
	if id != "agent-1" || ver != "2.0.0" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestKiroAmbiguousLookupFailsClosed(t *testing.T) {
	attributionHome(t)
	installAgent(t, "kiro", lockfile.Entry{
		Name: "review-bot", ID: "agent-1", Version: version("1.0.0"),
		Scope: "project", Directory: "/tmp/proj-a",
	})
	installAgent(t, "kiro", lockfile.Entry{
		Name: "review-bot", ID: "agent-2", Version: version("2.0.0"),
		Scope: "project", Directory: "/tmp/proj-b",
	})
	jsonlPath := writeKiroSession(t, t.TempDir(), "s1",
		`{"session_state": {"agent_name": "review-bot"}}`)

	id, ver := ResolveAgent("kiro", "", jsonlPath, nil)
	if id != nil || ver != nil {
		t.Fatalf("ResolveAgent = %v, %v; ambiguity must fail closed", id, ver)
	}
}

func TestEnvAgentIDResolvesVersion(t *testing.T) {
	attributionHome(t)
	installAgent(t, "claude-code", lockfile.Entry{
		Name: "helper", ID: "uuid-1", Version: version("3.1.0"), Scope: "user",
	})
	t.Setenv("CARACAL_AGENT_ID", "uuid-1")

	id, ver := ResolveAgent("claude-code", "", "", nil)
	if id != "uuid-1" || ver != "3.1.0" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestEnvAgentIDFallsBackAcrossHarnesses(t *testing.T) {
	attributionHome(t)
	installAgent(t, "copilot", lockfile.Entry{
		Name: "helper", ID: "uuid-1", Version: version("3.1.0"), Scope: "user",
	})
	t.Setenv("CARACAL_AGENT_ID", "uuid-1")

	// The harness recorded at pull time (copilot) differs from the harness
	// reporting the session (copilot-cli); an unscoped lookup still attributes.
	id, ver := ResolveAgent("copilot-cli", "", "", nil)
	if id != "uuid-1" || ver != "3.1.0" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestEnvAgentIDUnknownStaysUnattributed(t *testing.T) {
	attributionHome(t)
	t.Setenv("CARACAL_AGENT_ID", "uuid-does-not-exist")

	id, ver := ResolveAgent("claude-code", "/tmp/proj", "", nil)
	if id != nil || ver != nil {
		t.Fatalf("ResolveAgent = %v, %v; unknown explicit id must stay unattributed", id, ver)
	}
}

func TestEnvAgentNameResolvesVersion(t *testing.T) {
	attributionHome(t)
	installAgent(t, "claude-code", lockfile.Entry{
		Name: "helper", ID: "uuid-1", Version: version("1.2.3"), Scope: "user",
	})
	t.Setenv("CARACAL_AGENT_NAME", "helper")

	id, ver := ResolveAgent("claude-code", "", "", nil)
	if id != "uuid-1" || ver != "1.2.3" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestEnvAgentNameWithoutLockfileKeepsName(t *testing.T) {
	attributionHome(t)
	t.Setenv("CARACAL_AGENT_NAME", "helper")

	id, ver := ResolveAgent("claude-code", "", "", nil)
	if id != "helper" || ver != nil {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestEnvAgentNameMismatchKeepsNameWithoutVersion(t *testing.T) {
	attributionHome(t)
	installAgent(t, "claude-code", lockfile.Entry{
		Name: "other-agent", ID: "uuid-9", Version: version("9.9.9"),
		Scope: "project", Directory: "/tmp/proj",
	})
	t.Setenv("CARACAL_AGENT_NAME", "helper")

	id, ver := ResolveAgent("claude-code", "/tmp/proj", "", nil)
	if id != "helper" || ver != nil {
		t.Fatalf("ResolveAgent = %v, %v; a directory entry for another agent must not lend its version", id, ver)
	}
}

func TestAgentSettingRecordResolvesVersion(t *testing.T) {
	attributionHome(t)
	installAgent(t, "claude-code", lockfile.Entry{
		Name: "helper", ID: "uuid-1", Version: version("1.2.3"), Scope: "user",
	})
	lines := []string{
		`{"type": "message", "content": "hello"}`,
		`{"type": "agent-setting", "agentSetting": "helper"}`,
	}

	id, ver := ResolveAgent("claude-code", "", "", lines)
	if id != "uuid-1" || ver != "1.2.3" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestDirectoryFallbackWhenNoNameSources(t *testing.T) {
	attributionHome(t)
	installAgent(t, "claude-code", lockfile.Entry{
		Name: "helper", ID: "uuid-1", Version: version("1.2.3"),
		Scope: "project", Directory: "/tmp/proj",
	})

	id, ver := ResolveAgent("claude-code", "/tmp/proj", "", nil)
	if id != "uuid-1" || ver != "1.2.3" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestNameMatchPrefersDirectoryThenUserScope(t *testing.T) {
	attributionHome(t)
	installAgent(t, "claude-code", lockfile.Entry{
		Name: "helper", ID: "uuid-project", Version: version("1.0.0"),
		Scope: "project", Directory: "/tmp/elsewhere",
	})
	installAgent(t, "claude-code", lockfile.Entry{
		Name: "helper", ID: "uuid-user", Version: version("2.0.0"), Scope: "user",
	})
	t.Setenv("CARACAL_AGENT_NAME", "helper")

	// No directory match: the user-scoped install wins over a foreign project.
	id, ver := ResolveAgent("claude-code", "/tmp/proj", "", nil)
	if id != "uuid-user" || ver != "2.0.0" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}

	// An exact directory match beats scope preference.
	id, ver = ResolveAgent("claude-code", "/tmp/elsewhere", "", nil)
	if id != "uuid-project" || ver != "1.0.0" {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestNoSourcesStaysUnattributed(t *testing.T) {
	attributionHome(t)

	id, ver := ResolveAgent("claude-code", "", "", nil)
	if id != nil || ver != nil {
		t.Fatalf("ResolveAgent = %v, %v", id, ver)
	}
}

func TestBuildPayloadCarriesAttribution(t *testing.T) {
	attributionHome(t)
	installAgent(t, "claude-code", lockfile.Entry{
		Name: "helper", ID: "uuid-1", Version: version("1.2.3"),
		Scope: "project", Directory: "/tmp/proj",
	})
	source := Source{Harness: "claude-code", SessionID: "s1", Path: "/tmp/s1.jsonl", CWD: "/tmp/proj"}

	payload := BuildPayload(source, []string{`{"type":"message"}`}, 0, 0, 10, "Stop")
	if payload["agent_id"] != "uuid-1" || payload["agent_version"] != "1.2.3" {
		t.Fatalf("payload attribution = %v, %v", payload["agent_id"], payload["agent_version"])
	}
}
