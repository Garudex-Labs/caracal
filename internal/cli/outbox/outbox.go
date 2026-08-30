// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package outbox is the durable SQLite store for acknowledged session
// delivery: observed records persist before network delivery and are
// deleted only after the server acknowledges a contiguous checkpoint.
package outbox

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	// MaxBytes caps the durable outbox size.
	MaxBytes = 256 * 1024 * 1024
	// BatchSize is the default pending-read window.
	BatchSize = 50
)

// ErrFull reports a capacity rejection instead of dropped telemetry.
var ErrFull = errors.New("durable telemetry outbox reached capacity")

// ErrConflict reports one source range queued with different records.
var ErrConflict = errors.New("different records already queued")

// Item is one durable source batch.
type Item struct {
	ID            int64
	Destination   string
	UserID        string
	Harness       string
	SessionID     string
	CheckpointKey string
	StartLine     int64
	EndLine       int64
	EndOffset     int64
	Final         bool
	Payload       map[string]any
	Attempts      int64
}

// Stats carries the durable outbox statistics for status commands.
type Stats struct {
	Pending       int64
	Failed        int64
	Sent          int64
	Total         int64
	OldestPending *string
	LastSync      *string
	Bytes         int64
}

// Store wraps one outbox database file.
type Store struct {
	Path     string
	MaxBytes int64
	db       *sql.DB
}

// DefaultPath returns the shared buffer location under the CLI state dir.
func DefaultPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".caracal", "telemetry_buffer.db")
}

// Open initializes the schema, size cap, and owner-only permissions.
func Open(path string) (*Store, error) {
	if path == "" {
		path = DefaultPath()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("cannot open durable telemetry outbox: %w", err)
	}
	db, err := sql.Open("sqlite", path+"?_time_format=sqlite&_busy_timeout=3000")
	if err != nil {
		return nil, fmt.Errorf("cannot open durable telemetry outbox: %w", err)
	}
	store := &Store{Path: path, MaxBytes: MaxBytes, db: db}
	statements := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"PRAGMA busy_timeout=3000",
		`CREATE TABLE IF NOT EXISTS session_outbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			destination TEXT NOT NULL,
			user_id TEXT NOT NULL,
			harness TEXT NOT NULL,
			session_id TEXT NOT NULL,
			checkpoint_key TEXT NOT NULL,
			start_line INTEGER NOT NULL,
			end_line INTEGER NOT NULL,
			end_offset INTEGER NOT NULL,
			final INTEGER NOT NULL DEFAULT 0,
			payload TEXT NOT NULL,
			records_hash TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_attempt TEXT,
			UNIQUE(destination, user_id, harness, session_id, start_line, end_line)
		)`,
		"CREATE INDEX IF NOT EXISTS idx_session_outbox_pending ON session_outbox(destination, user_id, id)",
		`CREATE TABLE IF NOT EXISTS session_outbox_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			last_sync TEXT
		)`,
	}
	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("cannot open durable telemetry outbox: %w", err)
		}
	}
	var pageSize int64
	_ = db.QueryRow("PRAGMA page_size").Scan(&pageSize)
	if pageSize > 0 {
		_, _ = db.Exec(fmt.Sprintf("PRAGMA max_page_count = %d", max64(1, store.MaxBytes/pageSize)))
	}
	_ = os.Chmod(path, 0o600)
	return store, nil
}

// Close releases the underlying database handle.
func (s *Store) Close() error { return s.db.Close() }

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// usedBytes reports allocated minus free pages, matching capacity math.
func (s *Store) usedBytes() int64 {
	var pageSize, pageCount, freePages int64
	_ = s.db.QueryRow("PRAGMA page_size").Scan(&pageSize)
	_ = s.db.QueryRow("PRAGMA page_count").Scan(&pageCount)
	_ = s.db.QueryRow("PRAGMA freelist_count").Scan(&freePages)
	return (pageCount - freePages) * pageSize
}

// recordsHash fingerprints the payload lines for range-conflict detection.
func recordsHash(payload map[string]any) string {
	lines, _ := payload["lines"].([]any)
	parts := make([]string, len(lines))
	for i, line := range lines {
		parts[i] = fmt.Sprint(line)
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])
}

// compactJSON renders the payload in the stored wire form.
func compactJSON(payload map[string]any) (string, error) {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		return "", err
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// Enqueue persists one source batch and returns its durable row ID.
// Re-queuing the same range is idempotent; different content is rejected.
func (s *Store) Enqueue(payload map[string]any, destination, userID, checkpointKey string) (int64, error) {
	lines, _ := payload["lines"].([]any)
	if len(lines) == 0 && payload["total_credits"] == nil && !boolOf(payload["final"]) {
		return 0, errors.New("empty session outbox payload must contain durable metadata")
	}
	harness := strOf(payload["harness"])
	sessionID := strOf(payload["session_id"])
	if destination == "" || userID == "" || harness == "" || sessionID == "" {
		return 0, errors.New("destination, user_id, harness, and session_id are required")
	}
	destination = strings.TrimRight(destination, "/")

	startLine := intOf(payload["start_offset"])
	endLine := startLine + int64(len(lines)) - 1
	endOffset := intOf(payload["total_offset"])
	if offsets, ok := payload["end_byte_offsets"].([]any); ok && len(offsets) > 0 {
		endOffset = intOf(offsets[len(offsets)-1])
	}
	final := boolOf(payload["final"])
	serialized, err := compactJSON(payload)
	if err != nil {
		return 0, fmt.Errorf("cannot persist session records: %w", err)
	}
	hash := recordsHash(payload)
	if checkpointKey == "" {
		checkpointKey = sessionID
	}

	var existingID int64
	var existingHash string
	row := s.db.QueryRow(
		`SELECT id, records_hash FROM session_outbox
		 WHERE destination = ? AND user_id = ? AND harness = ? AND session_id = ?
		 AND start_line = ? AND end_line = ?`,
		destination, userID, harness, sessionID, startLine, endLine)
	scanErr := row.Scan(&existingID, &existingHash)
	exists := scanErr == nil
	if exists && existingHash != hash {
		return 0, fmt.Errorf("%w for %s/%s lines %d-%d", ErrConflict, harness, sessionID, startLine, endLine)
	}
	if !exists && s.usedBytes()+int64(len(serialized))+4096 > s.MaxBytes {
		return 0, fmt.Errorf("%w (%d bytes)", ErrFull, s.MaxBytes)
	}

	finalInt := 0
	if final {
		finalInt = 1
	}
	if _, err := s.db.Exec(
		`INSERT INTO session_outbox (
			destination, user_id, harness, session_id, checkpoint_key,
			start_line, end_line, end_offset, final, payload, records_hash
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(destination, user_id, harness, session_id, start_line, end_line)
		DO UPDATE SET
			checkpoint_key = excluded.checkpoint_key,
			end_offset = max(session_outbox.end_offset, excluded.end_offset),
			final = max(session_outbox.final, excluded.final),
			payload = CASE
				WHEN excluded.final = 1 OR excluded.end_line < excluded.start_line THEN excluded.payload
				ELSE session_outbox.payload
			END`,
		destination, userID, harness, sessionID, checkpointKey,
		startLine, endLine, endOffset, finalInt, serialized, hash); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "full") {
			return 0, fmt.Errorf("%w: disk or page cap", ErrFull)
		}
		return 0, fmt.Errorf("cannot persist session records: %w", err)
	}
	var id int64
	if err := s.db.QueryRow(
		`SELECT id FROM session_outbox
		 WHERE destination = ? AND user_id = ? AND harness = ? AND session_id = ?
		 AND start_line = ? AND end_line = ?`,
		destination, userID, harness, sessionID, startLine, endLine).Scan(&id); err != nil {
		return 0, fmt.Errorf("cannot persist session records: %w", err)
	}
	return id, nil
}

// Pending returns durable batches oldest-first; attempts never make a row
// terminal, and metadata-only rows sort after record batches.
func (s *Store) Pending(destination, userID string, limit int64) ([]Item, error) {
	if limit <= 0 {
		limit = BatchSize
	}
	rows, err := s.db.Query(
		`SELECT id, destination, user_id, harness, session_id, checkpoint_key,
		 start_line, end_line, end_offset, final, payload, attempts
		 FROM session_outbox WHERE destination = ? AND user_id = ?
		 ORDER BY (end_line < start_line), id LIMIT ?`,
		strings.TrimRight(destination, "/"), userID, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []Item{}
	for rows.Next() {
		var item Item
		var finalInt int64
		var payload string
		if err := rows.Scan(&item.ID, &item.Destination, &item.UserID, &item.Harness,
			&item.SessionID, &item.CheckpointKey, &item.StartLine, &item.EndLine,
			&item.EndOffset, &finalInt, &payload, &item.Attempts); err != nil {
			return nil, err
		}
		item.Final = finalInt != 0
		if err := json.Unmarshal([]byte(payload), &item.Payload); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// SpooledCheckpoint returns the contiguous local checkpoint including
// durable pending batches.
func (s *Store) SpooledCheckpoint(destination, userID, harness, sessionID, checkpointKey string, lineCount, byteOffset int64) (int64, int64, error) {
	rows, err := s.db.Query(
		`SELECT start_line, end_line, end_offset FROM session_outbox
		 WHERE destination = ? AND user_id = ? AND harness = ? AND session_id = ? AND checkpoint_key = ?
		 ORDER BY start_line, end_line`,
		strings.TrimRight(destination, "/"), userID, harness, sessionID, checkpointKey)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = rows.Close() }()
	expected := lineCount
	offset := byteOffset
	for rows.Next() {
		var startLine, endLine, endOffset int64
		if err := rows.Scan(&startLine, &endLine, &endOffset); err != nil {
			return 0, 0, err
		}
		if startLine > expected {
			break
		}
		if endLine < expected {
			continue
		}
		expected = endLine + 1
		if endOffset > offset {
			offset = endOffset
		}
	}
	return offset, expected, rows.Err()
}

// RecordAttempt logs a failed attempt without discarding the batch.
func (s *Store) RecordAttempt(itemID int64) error {
	_, err := s.db.Exec(
		"UPDATE session_outbox SET attempts = attempts + 1, last_attempt = datetime('now') WHERE id = ?", itemID)
	return err
}

// AcceptItem removes one posted batch.
func (s *Store) AcceptItem(itemID int64) error {
	_, err := s.db.Exec("DELETE FROM session_outbox WHERE id = ?", itemID)
	return err
}

// Quarantine preserves a permanently rejected batch outside the queue.
func (s *Store) Quarantine(item Item, reason string) (string, error) {
	path := strings.TrimSuffix(s.Path, filepath.Ext(s.Path)) + ".rejected.jsonl"
	record := map[string]any{
		"quarantined_at": time.Now().UTC().Format("2006-01-02T15:04:05.999999-07:00"),
		"reason":         reason,
		"destination":    item.Destination,
		"user_id":        item.UserID,
		"harness":        item.Harness,
		"session_id":     item.SessionID,
		"checkpoint_key": item.CheckpointKey,
		"start_line":     item.StartLine,
		"end_line":       item.EndLine,
		"payload":        item.Payload,
	}
	blob, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Write(append(blob, '\n')); err != nil {
		return "", err
	}
	if err := file.Sync(); err != nil {
		return "", err
	}
	return path, s.AcceptItem(item.ID)
}

// Acknowledge deletes acknowledged source batches; metadata-only rows go
// only when they were themselves posted.
func (s *Store) Acknowledge(destination, userID, harness, sessionID string, acknowledgedLine int64, includeMetadata bool) (int64, error) {
	meta := 0
	if includeMetadata {
		meta = 1
	}
	result, err := s.db.Exec(
		`DELETE FROM session_outbox WHERE destination = ? AND user_id = ? AND harness = ?
		 AND session_id = ? AND end_line <= ?
		 AND (end_line >= start_line OR ? = 1)`,
		strings.TrimRight(destination, "/"), userID, harness, sessionID, acknowledgedLine, meta)
	if err != nil {
		return 0, err
	}
	affected, _ := result.RowsAffected()
	if affected > 0 {
		if _, err := s.db.Exec(
			`INSERT INTO session_outbox_state (id, last_sync) VALUES (1, datetime('now'))
			 ON CONFLICT(id) DO UPDATE SET last_sync = excluded.last_sync`); err != nil {
			return affected, err
		}
	}
	return affected, nil
}

// ReadStats reports durable outbox statistics for status commands.
func (s *Store) ReadStats() (Stats, error) {
	out := Stats{}
	if err := s.db.QueryRow("SELECT COUNT(*) FROM session_outbox").Scan(&out.Pending); err != nil {
		return out, err
	}
	var oldest sql.NullString
	_ = s.db.QueryRow("SELECT created_at FROM session_outbox ORDER BY id LIMIT 1").Scan(&oldest)
	if oldest.Valid {
		out.OldestPending = &oldest.String
	}
	var lastSync sql.NullString
	_ = s.db.QueryRow("SELECT last_sync FROM session_outbox_state WHERE id = 1").Scan(&lastSync)
	if lastSync.Valid {
		out.LastSync = &lastSync.String
	}
	quarantinePath := strings.TrimSuffix(s.Path, filepath.Ext(s.Path)) + ".rejected.jsonl"
	if blob, err := os.ReadFile(quarantinePath); err == nil {
		for _, line := range strings.Split(strings.TrimRight(string(blob), "\n"), "\n") {
			if line != "" {
				out.Failed++
			}
		}
	}
	out.Total = out.Pending + out.Failed
	out.Bytes = s.usedBytes()
	return out, nil
}

func strOf(v any) string {
	switch value := v.(type) {
	case string:
		return value
	case nil:
		return ""
	default:
		return fmt.Sprint(value)
	}
}

func intOf(v any) int64 {
	switch value := v.(type) {
	case float64:
		return int64(value)
	case int:
		return int64(value)
	case int64:
		return value
	case json.Number:
		n, _ := value.Int64()
		return n
	}
	return 0
}

func boolOf(v any) bool {
	b, _ := v.(bool)
	return b
}
