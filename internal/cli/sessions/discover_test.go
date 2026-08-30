// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func write(t *testing.T, path, content string, mtime time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if !mtime.IsZero() {
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDiscoverClaudeCode(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".claude", "projects")
	write(t, filepath.Join(root, "-home-u-proj", "sess-a.jsonl"), "{}\n", time.Time{})
	write(t, filepath.Join(root, "-home-u-proj", "sess-b.jsonl"), "{}\n", time.Now().Add(-200*time.Hour))
	write(t, filepath.Join(root, "-home-u-proj", "sess-a", "subagents", "agent-child1.jsonl"), "{}\n", time.Time{})
	sources, err := discoverClaudeCode(home, 168)
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources = %+v err %v", sources, err)
	}
	if sources[0].SessionID != "sess-a" || sources[0].CursorKey != "" {
		t.Fatalf("primary = %+v", sources[0])
	}
	sub := sources[1]
	if sub.SessionID != "child1" || sub.CursorKey != "sess-a__sub__child1" ||
		sub.ParentSessionID == nil || *sub.ParentSessionID != "sess-a" {
		t.Fatalf("subagent = %+v", sub)
	}
}

func TestDiscoverCursorDedupeAndOrder(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".cursor", "projects", "home-u-proj")
	older := time.Now().Add(-2 * time.Hour)
	write(t, filepath.Join(root, "agent-transcripts", "s1", "s1.jsonl"), "{}\n", older)
	write(t, filepath.Join(root, "agent-transcripts", "s2", "s2.jsonl"), "{}\n", time.Time{})
	write(t, filepath.Join(root, "parent9", "subagents", "agent-s3.jsonl"), "{}\n", older.Add(-time.Hour))
	sources, err := discoverCursor(home, 168)
	if err != nil || len(sources) != 3 {
		t.Fatalf("sources = %+v err %v", sources, err)
	}
	if sources[0].SessionID != "s2" {
		t.Fatalf("newest first: %+v", sources[0])
	}
	last := sources[2]
	if last.SessionID != "s3" || last.CursorKey != "parent9__sub__s3" || *last.ParentSessionID != "parent9" {
		t.Fatalf("subagent = %+v", last)
	}
}

func TestDiscoverCopilotCLIGlobFallback(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".copilot", "session-state")
	write(t, filepath.Join(dir, "uuid-1", "events.jsonl"), "{}\n", time.Now().Add(-time.Hour))
	write(t, filepath.Join(dir, "uuid-2", "events.jsonl"), "{}\n", time.Time{})
	write(t, filepath.Join(dir, "uuid-3", "events.jsonl"), "{}\n", time.Now().Add(-400*time.Hour))
	sources, err := discoverCopilotCLI(home, 168)
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources = %+v err %v", sources, err)
	}
	if sources[0].SessionID != "uuid-2" || sources[1].SessionID != "uuid-1" {
		t.Fatalf("order = %+v", sources)
	}
	if sources[0].Harness != "copilot-cli" {
		t.Fatalf("harness = %s", sources[0].Harness)
	}
}

func TestDiscoverAntigravity(t *testing.T) {
	home := t.TempDir()
	brain := filepath.Join(home, ".gemini", "antigravity-cli", "brain")
	write(t, filepath.Join(brain, "sess-x", ".system_generated", "logs", "transcript.jsonl"), "{}\n", time.Now().Add(-time.Hour))
	write(t, filepath.Join(brain, "sess-y", ".system_generated", "logs", "transcript.jsonl"), "{}\n", time.Time{})
	write(t, filepath.Join(brain, "sess-old", ".system_generated", "logs", "transcript.jsonl"), "{}\n", time.Now().Add(-300*time.Hour))
	sources, err := discoverAntigravity(home, 168)
	if err != nil || len(sources) != 2 {
		t.Fatalf("sources = %+v err %v", sources, err)
	}
	if sources[0].SessionID != "sess-y" || sources[1].SessionID != "sess-x" {
		t.Fatalf("order = %+v", sources)
	}
}

func TestInstalledMarkers(t *testing.T) {
	home := t.TempDir()
	if Installed("claude-code", home) {
		t.Fatal("no marker yet")
	}
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !Installed("claude-code", home) {
		t.Fatal("marker must be detected")
	}
	if err := os.MkdirAll(filepath.Join(home, ".gemini", "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !Installed("antigravity", home) {
		t.Fatal("nested marker must be detected")
	}
}
