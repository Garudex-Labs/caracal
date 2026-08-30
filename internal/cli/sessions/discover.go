// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"database/sql"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func homeOr(home string) string {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return home
}

func withinWindow(path string, cutoff time.Time) (os.FileInfo, bool) {
	info, err := os.Stat(path)
	if err != nil || info.ModTime().Before(cutoff) {
		return nil, false
	}
	return info, true
}

// discoverClaudeCode scans the projects tree for session transcripts and
// their subagent children, sorted by path.
func discoverClaudeCode(home string, sinceHours int) ([]Source, error) {
	root := filepath.Join(homeOr(home), ".claude", "projects")
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return []Source{}, nil
	}
	cutoff := time.Now().Add(-time.Duration(sinceHours) * time.Hour)
	sources := []Source{}
	primaries, _ := filepath.Glob(filepath.Join(root, "*", "*.jsonl"))
	for _, path := range primaries {
		if _, ok := withinWindow(path, cutoff); !ok {
			continue
		}
		sources = append(sources, Source{
			Harness:   "claude-code",
			SessionID: strings.TrimSuffix(filepath.Base(path), ".jsonl"),
			Path:      path,
		})
	}
	subagents, _ := filepath.Glob(filepath.Join(root, "*", "*", "subagents", "*.jsonl"))
	for _, path := range subagents {
		if _, ok := withinWindow(path, cutoff); !ok {
			continue
		}
		parent := filepath.Base(filepath.Dir(filepath.Dir(path)))
		subagentID := strings.TrimPrefix(strings.TrimSuffix(filepath.Base(path), ".jsonl"), "agent-")
		parentID := parent
		sources = append(sources, Source{
			Harness:         "claude-code",
			SessionID:       subagentID,
			Path:            path,
			CursorKey:       parent + "__sub__" + subagentID,
			ParentSessionID: &parentID,
		})
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].Path < sources[j].Path })
	return sources, nil
}

// discoverCursor walks the projects tree for transcripts, deduplicating by
// checkpoint key and sorting most recent first.
func discoverCursor(home string, sinceHours int) ([]Source, error) {
	root := filepath.Join(homeOr(home), ".cursor", "projects")
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return []Source{}, nil
	}
	cutoff := time.Now().Add(-time.Duration(sinceHours) * time.Hour)
	type candidate struct {
		source Source
		mtime  time.Time
	}
	byKey := map[string]candidate{}
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		if info.ModTime().Before(cutoff) {
			return nil
		}
		sessionID := strings.TrimPrefix(strings.TrimSuffix(filepath.Base(path), ".jsonl"), "agent-")
		var parentID *string
		cursorKey := ""
		// Subagent transcripts live under <parent>/subagents/.
		if filepath.Base(filepath.Dir(path)) == "subagents" {
			parent := filepath.Base(filepath.Dir(filepath.Dir(path)))
			parentID = &parent
			cursorKey = parent + "__sub__" + sessionID
		}
		key := cursorKey
		if key == "" {
			key = sessionID
		}
		byKey[key] = candidate{
			source: Source{
				Harness: "cursor", SessionID: sessionID, Path: path,
				CursorKey: cursorKey, ParentSessionID: parentID,
			},
			mtime: info.ModTime(),
		}
		return nil
	})
	candidates := make([]candidate, 0, len(byKey))
	for _, c := range byKey {
		candidates = append(candidates, c)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].mtime.After(candidates[j].mtime) })
	sources := make([]Source, 0, len(candidates))
	for _, c := range candidates {
		sources = append(sources, c.source)
	}
	return sources, nil
}

// discoverCopilotCLI resolves session event logs, preferring the session
// index database and falling back to a directory scan.
func discoverCopilotCLI(home string, sinceHours int) ([]Source, error) {
	home = homeOr(home)
	sessionsDir := filepath.Join(home, ".copilot", "session-state")
	cutoff := time.Now().Add(-time.Duration(sinceHours) * time.Hour)

	paths := copilotIndexPaths(filepath.Join(home, ".copilot", "session-store.db"), sessionsDir)
	if paths == nil {
		if info, err := os.Stat(sessionsDir); err != nil || !info.IsDir() {
			return []Source{}, nil
		}
		globbed, _ := filepath.Glob(filepath.Join(sessionsDir, "*", "events.jsonl"))
		sort.Strings(globbed)
		paths = globbed
	}

	type candidate struct {
		source Source
		mtime  time.Time
	}
	candidates := []candidate{}
	for _, path := range paths {
		info, ok := withinWindow(path, cutoff)
		if !ok {
			continue
		}
		candidates = append(candidates, candidate{
			source: Source{Harness: "copilot-cli", SessionID: filepath.Base(filepath.Dir(path)), Path: path},
			mtime:  info.ModTime(),
		})
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].mtime.After(candidates[j].mtime) })
	sources := make([]Source, 0, len(candidates))
	for _, c := range candidates {
		sources = append(sources, c.source)
	}
	return sources, nil
}

// copilotIndexPaths reads the session index; nil means fall back to a scan.
func copilotIndexPaths(dbPath, sessionsDir string) []string {
	if _, err := os.Stat(dbPath); err != nil {
		return nil
	}
	db, err := sql.Open("sqlite", dbPath+"?mode=ro&_busy_timeout=2000")
	if err != nil {
		return nil
	}
	defer func() { _ = db.Close() }()
	rows, err := db.Query("SELECT id FROM sessions ORDER BY id")
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	paths := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil {
			return nil
		}
		jsonl := filepath.Join(sessionsDir, id, "events.jsonl")
		if _, err := os.Stat(jsonl); err == nil {
			paths = append(paths, jsonl)
		}
	}
	if rows.Err() != nil || len(paths) == 0 {
		return nil
	}
	return paths
}

// antigravityDir resolves the harness state directory, honoring the WSL
// Windows-home fallback.
func antigravityDir(home string) string {
	primary := filepath.Join(homeOr(home), ".gemini", "antigravity-cli")
	if _, err := os.Stat(primary); err == nil {
		return primary
	}
	if winHome := wslWindowsHome(); winHome != "" {
		candidate := filepath.Join(winHome, ".gemini", "antigravity-cli")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// wslWindowsHome reports the Windows user home when running under WSL.
func wslWindowsHome() string {
	if _, err := os.Stat("/proc/sys/fs/binfmt_misc/WSLInterop"); err != nil {
		return ""
	}
	profile := os.Getenv("USERPROFILE")
	if profile == "" {
		return ""
	}
	return profile
}

// discoverAntigravity scans the brain directory for session transcripts,
// most recent first.
func discoverAntigravity(home string, sinceHours int) ([]Source, error) {
	agDir := antigravityDir(home)
	if agDir == "" {
		return []Source{}, nil
	}
	brain := filepath.Join(agDir, "brain")
	if info, err := os.Stat(brain); err != nil || !info.IsDir() {
		return []Source{}, nil
	}
	cutoff := time.Now().Add(-time.Duration(sinceHours) * time.Hour)
	entries, err := os.ReadDir(brain)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		source Source
		mtime  time.Time
	}
	candidates := []candidate{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(brain, entry.Name(), ".system_generated", "logs", "transcript.jsonl")
		info, ok := withinWindow(path, cutoff)
		if !ok {
			continue
		}
		candidates = append(candidates, candidate{
			source: Source{Harness: "antigravity", SessionID: entry.Name(), Path: path},
			mtime:  info.ModTime(),
		})
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].mtime.After(candidates[j].mtime) })
	sources := make([]Source, 0, len(candidates))
	for _, c := range candidates {
		sources = append(sources, c.source)
	}
	return sources, nil
}
