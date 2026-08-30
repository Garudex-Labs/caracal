// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/outbox"
)

// MaxChunkSize bounds the record count of one delivery batch.
const MaxChunkSize = 500

// Source is a harness session resolved from a hook or recent-session scan.
type Source struct {
	Harness         string
	SessionID       string
	Path            string
	CWD             string
	CursorKey       string
	ParentSessionID *string
}

// CheckpointKey returns the local checkpoint key for this source.
func (s Source) CheckpointKey() string {
	if s.CursorKey != "" {
		return s.CursorKey
	}
	return s.SessionID
}

// BuildPayload constructs the ingest request body. Identity attribution
// resolves through the installed-agent lockfile; sources without one stay
// unattributed.
func BuildPayload(source Source, lines []string, startOffset, lineCountBefore, newOffset int64, hookEvent string) map[string]any {
	items := make([]any, len(lines))
	for i, line := range lines {
		items[i] = line
	}
	var parent any
	if source.ParentSessionID != nil {
		parent = *source.ParentSessionID
	}
	agentID, agentVersion := ResolveAgent(source.Harness, source.CWD, source.Path, lines)
	payload := map[string]any{
		"session_id":        source.SessionID,
		"harness":           "claude-code",
		"agent_id":          agentID,
		"agent_version":     agentVersion,
		"layer_hash":        nil,
		"lines":             items,
		"start_offset":      startOffset,
		"hook_event":        hookEvent,
		"parent_session_id": parent,
	}
	if hookEvent == "Stop" {
		payload["final"] = true
		payload["total_line_count"] = lineCountBefore + int64(len(lines))
		payload["total_offset"] = newOffset
	}
	return payload
}

// checkpointByteOffset resolves a server source position to a safe local
// newline boundary, or -1 when the source diverged.
func checkpointByteOffset(path string, lineCount, serverOffset int64) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return -1
	}
	if serverOffset > 0 {
		if serverOffset > info.Size() {
			return -1
		}
		file, err := os.Open(path)
		if err != nil {
			return -1
		}
		defer func() { _ = file.Close() }()
		buf := make([]byte, 1)
		if _, err := file.ReadAt(buf, serverOffset-1); err != nil || buf[0] != '\n' {
			return -1
		}
		return serverOffset
	}
	if lineCount == 0 {
		return 0
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		return -1
	}
	var seen, offset int64
	rest := blob
	for len(rest) > 0 {
		idx := indexByte(rest, '\n')
		var encoded []byte
		if idx >= 0 {
			encoded = rest[:idx+1]
			rest = rest[idx+1:]
		} else {
			encoded = rest
			rest = nil
		}
		offset += int64(len(encoded))
		if strings.TrimSpace(strings.TrimRight(string(encoded), "\r\n")) != "" {
			seen++
			if seen == lineCount {
				return offset
			}
		}
	}
	return -1
}

func indexByte(data []byte, c byte) int {
	for i, b := range data {
		if b == c {
			return i
		}
	}
	return -1
}

// RecoverCursorFromServer replaces missing, corrupt, or stale local state
// with the server checkpoint; a divergent source reports ok=false.
func RecoverCursorFromServer(cfg *Config, source Source, home string, fetch func(*Config, string, string) *Acknowledgement) (int64, int64, bool) {
	if source.Path == "" {
		return 0, 0, false
	}
	if fetch == nil {
		fetch = ServerCheckpoint
	}
	checkpoint := fetch(cfg, source.Harness, source.SessionID)
	if checkpoint == nil {
		offset, lineCount, _, _ := CursorStatus(source.CheckpointKey(), home)
		return offset, lineCount, true
	}
	lineCount := checkpoint.AcknowledgedLine + 1
	byteOffset := checkpointByteOffset(source.Path, lineCount, checkpoint.AcknowledgedOffset)
	if byteOffset < 0 {
		LogError(fmt.Sprintf("server checkpoint does not match local source for %s session %s",
			source.Harness, source.SessionID), home)
		return 0, 0, false
	}
	if err := WriteCursor(source.CheckpointKey(), byteOffset, lineCount, false, home, false); err != nil {
		return 0, 0, false
	}
	return byteOffset, lineCount, true
}

// SourceOptions parameterize one per-source delivery pass.
type SourceOptions struct {
	HookEvent         string
	Final             bool
	ExtraFields       map[string]any
	ExtraRecords      []string
	SpoolOnly         bool
	RecoverFromServer bool
	Home              string
	DBPath            string
	Post              func(cfg *Config, payload map[string]any) (*Acknowledgement, error)
	CheckpointFetch   func(*Config, string, string) *Acknowledgement
	Rejections        *[]Rejection
	repairAttempts    int
}

func sourceRejected(rejections *[]Rejection, source Source) bool {
	if rejections == nil {
		return false
	}
	for _, rejection := range *rejections {
		if rejection.Harness == source.Harness && rejection.SessionID == source.SessionID {
			return true
		}
	}
	return false
}

// DrainSessionSource spools all complete source records, then delivers them
// through the outbox.
func DrainSessionSource(cfg *Config, source Source, opts SourceOptions) (bool, error) {
	destination := scopedDestination(cfg)
	if source.Path == "" || destination == "" || cfg.UserID == "" {
		return false, nil
	}
	drainOpts := DrainOptions{Home: opts.Home, DBPath: opts.DBPath, Post: opts.Post}

	// A transient pre-drain failure never prevents new records from spooling.
	if !opts.SpoolOnly {
		if _, err := DrainOutbox(cfg, drainOpts, opts.Rejections, nil); err != nil {
			return false, err
		}
		if sourceRejected(opts.Rejections, source) {
			return false, nil
		}
	}

	var byteOffset, lineCount int64
	if opts.RecoverFromServer {
		var ok bool
		byteOffset, lineCount, ok = RecoverCursorFromServer(cfg, source, opts.Home, opts.CheckpointFetch)
		if !ok {
			return false, nil
		}
	} else {
		byteOffset, lineCount, _, _ = CursorStatus(source.CheckpointKey(), opts.Home)
	}
	store, err := outbox.Open(opts.DBPath)
	if err != nil {
		return false, err
	}
	byteOffset, lineCount, err = store.SpooledCheckpoint(destination, cfg.UserID,
		source.Harness, source.SessionID, source.CheckpointKey(), lineCount, byteOffset)
	if err != nil {
		_ = store.Close()
		return false, err
	}

	var sessionHash any
	var hashedLineCount any
	if opts.Final {
		hash, count, err := HashSessionSource(source.Path)
		if err != nil {
			_ = store.Close()
			return false, err
		}
		sessionHash, hashedLineCount = hash, count
	}
	lines, endOffsets, bytesRead, err := ReadNewRecords(source.Path, byteOffset)
	if err != nil {
		_ = store.Close()
		return false, err
	}
	for _, record := range opts.ExtraRecords {
		lines = append(lines, record)
		endOffsets = append(endOffsets, byteOffset+bytesRead)
	}

	enqueue := func(payload map[string]any) error {
		_, err := store.Enqueue(payload, destination, cfg.UserID, source.CheckpointKey())
		return err
	}

	retryAfterRepair := func(repairs []Repair, delivered bool) (bool, bool, error) {
		if opts.Final && opts.repairAttempts < 1 {
			for _, repair := range repairs {
				if repair.Harness == source.Harness && repair.SessionID == source.SessionID {
					retryOpts := opts
					retryOpts.repairAttempts++
					done, err := DrainSessionSource(cfg, source, retryOpts)
					return true, done, err
				}
			}
		}
		return false, delivered, nil
	}

	if len(lines) == 0 {
		if bytesRead > 0 {
			byteOffset += bytesRead
		}
		if len(opts.ExtraFields) > 0 || opts.Final {
			payload := BuildPayload(source, nil, lineCount, lineCount, byteOffset, opts.HookEvent)
			payload["harness"] = source.Harness
			for key, value := range opts.ExtraFields {
				payload[key] = value
			}
			if opts.Final {
				payload["final"] = true
				payload["total_line_count"] = lineCount
				payload["total_offset"] = byteOffset
				payload["session_hash"] = sessionHash
				payload["hashed_line_count"] = hashedLineCount
			}
			if err := enqueue(payload); err != nil {
				_ = store.Close()
				return false, err
			}
		}
		_ = store.Close()
		if opts.SpoolOnly {
			return true, nil
		}
		repairs := []Repair{}
		delivered, err := DrainOutbox(cfg, drainOpts, opts.Rejections, &repairs)
		if err != nil {
			return false, err
		}
		if retried, done, err := retryAfterRepair(repairs, delivered); retried {
			return done, err
		}
		if bytesRead > 0 || (opts.Final && delivered && !sourceRejected(opts.Rejections, source)) {
			if err := WriteCursor(source.CheckpointKey(), byteOffset, lineCount,
				opts.Final && delivered, opts.Home, true); err != nil {
				return false, err
			}
		}
		return delivered && !sourceRejected(opts.Rejections, source), nil
	}

	// Attribute trailing blank-line bytes to the last real record checkpoint.
	endOffsets[len(endOffsets)-1] = byteOffset + bytesRead

	for chunkStart := 0; chunkStart < len(lines); chunkStart += MaxChunkSize {
		chunkEnd := chunkStart + MaxChunkSize
		if chunkEnd > len(lines) {
			chunkEnd = len(lines)
		}
		chunk := lines[chunkStart:chunkEnd]
		chunkOffsets := endOffsets[chunkStart:chunkEnd]
		isLast := chunkStart+MaxChunkSize >= len(lines)
		newOffset := chunkOffsets[len(chunkOffsets)-1]
		if isLast {
			newOffset = byteOffset + bytesRead
		}
		payload := BuildPayload(source, chunk, lineCount+int64(chunkStart),
			lineCount+int64(chunkStart), newOffset, opts.HookEvent)
		payload["harness"] = source.Harness
		offsetsAny := make([]any, len(chunkOffsets))
		for i, v := range chunkOffsets {
			offsetsAny[i] = v
		}
		payload["end_byte_offsets"] = offsetsAny
		if opts.Final && isLast {
			payload["final"] = true
			payload["total_line_count"] = lineCount + int64(len(lines))
			payload["total_offset"] = byteOffset + bytesRead
			payload["session_hash"] = sessionHash
			payload["hashed_line_count"] = hashedLineCount
		} else {
			delete(payload, "final")
			delete(payload, "total_line_count")
			delete(payload, "total_offset")
		}
		for key, value := range opts.ExtraFields {
			payload[key] = value
		}
		if err := enqueue(payload); err != nil {
			_ = store.Close()
			return false, err
		}
	}
	_ = store.Close()

	if opts.SpoolOnly {
		return true, nil
	}
	repairs := []Repair{}
	delivered, err := DrainOutbox(cfg, drainOpts, opts.Rejections, &repairs)
	if err != nil {
		return false, err
	}
	if retried, done, err := retryAfterRepair(repairs, delivered); retried {
		return done, err
	}
	return delivered && !sourceRejected(opts.Rejections, source), nil
}

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

// Discoverer finds recent session sources for one installed harness.
type Discoverer struct {
	HomeMarkers []string
	Discover    func(home string, sinceHours int) ([]Source, error)
}

// Discoverers maps harness names to their session source scanners.
var Discoverers = map[string]Discoverer{
	"kiro": {
		HomeMarkers: []string{".kiro"},
		Discover:    discoverKiro,
	},
	"claude-code": {
		HomeMarkers: []string{".claude"},
		Discover:    discoverClaudeCode,
	},
	"cursor": {
		HomeMarkers: []string{".cursor"},
		Discover:    discoverCursor,
	},
	"copilot-cli": {
		HomeMarkers: []string{".copilot"},
		Discover:    discoverCopilotCLI,
	},
	"antigravity": {
		HomeMarkers: []string{".gemini/antigravity-cli", ".gemini/config"},
		Discover:    discoverAntigravity,
	},
	"goose": {
		HomeMarkers: []string{".config/goose", ".local/share/goose"},
		Discover:    discoverGoose,
	},
	"codex": {
		HomeMarkers: []string{".codex"},
		Discover:    discoverCodex,
	},
	"copilot": {
		HomeMarkers: []string{".caracal/session_sources/copilot"},
		Discover:    discoverCopilotVSCode,
	},
}

// Installed reports whether a harness leaves its home marker.
func Installed(name, home string) bool {
	discoverer, ok := Discoverers[name]
	if !ok {
		return false
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	for _, marker := range discoverer.HomeMarkers {
		if strings.ContainsAny(marker, "*?[") {
			if matches, err := filepath.Glob(filepath.Join(home, marker)); err == nil && len(matches) > 0 {
				return true
			}
			continue
		}
		if _, err := os.Stat(filepath.Join(home, marker)); err == nil {
			return true
		}
	}
	return false
}

// discoverKiro scans the session transcripts directory for recent sources.
func discoverKiro(home string, sinceHours int) ([]Source, error) {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	root := filepath.Join(home, ".kiro", "sessions", "cli")
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return []Source{}, nil
	}
	cutoff := time.Now().Add(-time.Duration(sinceHours) * time.Hour)
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".jsonl") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	sources := []Source{}
	for _, name := range names {
		path := filepath.Join(root, name)
		stat, err := os.Stat(path)
		if err != nil {
			continue
		}
		if stat.ModTime().Before(cutoff) {
			continue
		}
		sources = append(sources, Source{
			Harness:   "kiro",
			SessionID: strings.TrimSuffix(name, ".jsonl"),
			Path:      path,
			CWD:       kiroSessionCWD(path),
		})
	}
	return sources, nil
}

// kiroSessionCWD reads the working directory from the companion session file.
func kiroSessionCWD(jsonlPath string) string {
	companion := strings.TrimSuffix(jsonlPath, ".jsonl") + ".json"
	blob, err := os.ReadFile(companion)
	if err != nil {
		return ""
	}
	var session map[string]any
	if json.Unmarshal(blob, &session) != nil {
		return ""
	}
	cwd, _ := session["cwd"].(string)
	return strings.TrimSpace(cwd)
}
