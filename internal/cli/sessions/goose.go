// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Rows imported from other formats can carry millisecond timestamps; this is
// the same threshold the harness itself uses.
const gooseMillisecondThreshold = 10_000_000_000

// gooseCursorTailBytes bounds the tail read used to recover the export cursor.
const gooseCursorTailBytes = 64 * 1024

var gooseSessionColumns = []string{
	"id", "name", "description", "session_type", "working_dir",
	"created_at", "updated_at", "total_tokens", "input_tokens", "output_tokens",
	"accumulated_total_tokens", "accumulated_input_tokens", "accumulated_output_tokens",
	"accumulated_cost", "provider_name", "model_config_json", "goose_mode",
	"parent_session_id", "schedule_id",
}

// gooseDataDir resolves the harness data directory: an absolute
// GOOSE_PATH_ROOT wins, then XDG, then the default home layout.
func gooseDataDir(home string) string {
	if root := os.Getenv("GOOSE_PATH_ROOT"); root != "" && filepath.IsAbs(root) {
		return filepath.Join(root, "data")
	}
	if home != "" {
		return filepath.Join(home, ".local", "share", "goose")
	}
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
		return filepath.Join(xdg, "goose")
	}
	userHome, _ := os.UserHomeDir()
	return filepath.Join(userHome, ".local", "share", "goose")
}

func gooseSessionsDB(home string) string {
	return filepath.Join(gooseDataDir(home), "sessions", "sessions.db")
}

func gooseMirrorPath(sessionID, home string) string {
	return filepath.Join(caracalDir(home), "sessions", "goose", gooseSafeSessionID(sessionID)+".jsonl")
}

// gooseSafeSessionID keeps a session id usable as a filename everywhere.
func gooseSafeSessionID(sessionID string) string {
	var out []rune
	for _, r := range sessionID {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.' {
			out = append(out, r)
		} else {
			out = append(out, '_')
		}
		if len(out) == 128 {
			break
		}
	}
	return string(out)
}

// ---------------------------------------------------------------------------
// Mirror state
// ---------------------------------------------------------------------------

// gooseScanState returns the highest row_id and whether a session_end record
// appears in the blob.
func gooseScanState(blob []byte) (int64, bool) {
	var rowID int64
	hasEnd := false
	for _, line := range strings.Split(string(blob), "\n") {
		var record map[string]any
		if json.Unmarshal([]byte(line), &record) != nil || record == nil {
			continue
		}
		if raw, ok := record["row_id"].(float64); ok && raw == float64(int64(raw)) {
			if int64(raw) > rowID {
				rowID = int64(raw)
			}
		} else if record["type"] == "session_end" {
			hasEnd = true
		}
	}
	return rowID, hasEnd
}

// gooseMirrorState reads the export cursor and finalisation flag, escalating
// from the bounded tail only when the tail is inconclusive.
func gooseMirrorState(path string) (int64, bool) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return 0, false
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer func() { _ = file.Close() }()
	size := info.Size()
	offset := size - gooseCursorTailBytes
	if offset < 0 {
		offset = 0
	}
	tail := make([]byte, size-offset)
	if _, err := file.ReadAt(tail, offset); err != nil {
		return 0, false
	}
	rowID, hasEnd := gooseScanState(tail)
	if rowID != 0 || size <= gooseCursorTailBytes {
		return rowID, hasEnd
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	return gooseScanState(blob)
}

// ---------------------------------------------------------------------------
// Record building
// ---------------------------------------------------------------------------

func gooseISOTimestamp(created any) string {
	var epoch float64
	switch v := created.(type) {
	case int64:
		epoch = float64(v)
	case float64:
		epoch = v
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return ""
		}
		epoch = parsed
	default:
		return ""
	}
	if epoch > gooseMillisecondThreshold {
		epoch /= 1000.0
	}
	// Microsecond rounding first, millisecond truncation second, matching
	// how the mirror format has always rendered these.
	t := time.UnixMicro(int64(math.RoundToEven(epoch * 1e6))).UTC()
	return t.Format("2006-01-02T15:04:05.000") + "Z"
}

func gooseSQLTimestamp(value any) string {
	if value == nil {
		return ""
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" {
		return ""
	}
	text = strings.ReplaceAll(text, " ", "T")
	if strings.HasSuffix(text, "Z") || strings.Contains(text, "+") {
		return text
	}
	return text + "Z"
}

func gooseStr(row map[string]any, key string) string {
	if s, ok := row[key].(string); ok {
		return s
	}
	return ""
}

// gooseTokens mirrors the falsy-fallback chain: zero counts fall through.
func gooseTokens(row map[string]any, keys ...string) int64 {
	for _, key := range keys {
		switch v := row[key].(type) {
		case int64:
			if v != 0 {
				return v
			}
		case float64:
			if v != 0 {
				return int64(v)
			}
		}
	}
	return 0
}

func gooseSessionRecord(session map[string]any) *pyObject {
	modelConfig := map[string]any{}
	if raw, ok := session["model_config_json"].(string); ok && raw != "" {
		_ = json.Unmarshal([]byte(raw), &modelConfig)
	}
	model := ""
	if s, ok := modelConfig["model_name"].(string); ok && s != "" {
		model = s
	} else if s, ok := modelConfig["model"].(string); ok && s != "" {
		model = s
	}
	name := gooseStr(session, "name")
	if name == "" {
		name = gooseStr(session, "description")
	}
	sessionType := gooseStr(session, "session_type")
	if sessionType == "" {
		sessionType = "user"
	}
	record := newPyObject()
	record.set("type", "session")
	record.set("session_id", gooseStr(session, "id"))
	record.set("name", name)
	record.set("session_type", sessionType)
	record.set("working_dir", gooseStr(session, "working_dir"))
	record.set("parent_session_id", session["parent_session_id"])
	record.set("schedule_id", session["schedule_id"])
	record.set("goose_mode", gooseStr(session, "goose_mode"))
	record.set("provider", gooseStr(session, "provider_name"))
	record.set("model", model)
	record.set("timestamp", gooseSQLTimestamp(session["created_at"]))
	return record
}

func gooseSessionEndRecord(session map[string]any) *pyObject {
	usage := newPyObject()
	usage.set("inputTokens", gooseTokens(session, "accumulated_input_tokens", "input_tokens"))
	usage.set("outputTokens", gooseTokens(session, "accumulated_output_tokens", "output_tokens"))
	usage.set("totalTokens", gooseTokens(session, "accumulated_total_tokens", "total_tokens"))
	usage.set("cost", session["accumulated_cost"])
	record := newPyObject()
	record.set("type", "session_end")
	record.set("session_id", gooseStr(session, "id"))
	record.set("timestamp", gooseSQLTimestamp(session["updated_at"]))
	record.set("usage", usage)
	return record
}

type gooseMessageRow struct {
	rowID            int64
	role             string
	contentJSON      string
	createdTimestamp any
	messageID        any
	metadataJSON     string
	hasMessageID     bool
	hasMetadata      bool
}

func gooseMessageRecord(row gooseMessageRow, sessionID string) *pyObject {
	content := parsePyValue(row.contentJSON, pyList{})
	var metadata any
	if row.hasMetadata {
		metadata = parsePyValue(row.metadataJSON, newPyObject())
	} else {
		metadata = newPyObject()
	}
	record := newPyObject()
	record.set("type", "message")
	record.set("row_id", row.rowID)
	record.set("session_id", sessionID)
	if row.hasMessageID {
		record.set("message_id", row.messageID)
	} else {
		record.set("message_id", nil)
	}
	record.set("role", row.role)
	record.set("timestamp", gooseISOTimestamp(row.createdTimestamp))
	record.set("content", content)
	record.set("metadata", metadata)
	return record
}

// ---------------------------------------------------------------------------
// Read-only database access
// ---------------------------------------------------------------------------

func gooseConnect(dbPath string) (*sql.DB, error) {
	return sql.Open("sqlite", dbPath+"?mode=ro&_busy_timeout=5000")
}

func gooseTableColumns(db *sql.DB, table string) map[string]bool {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return map[string]bool{}
	}
	defer func() { _ = rows.Close() }()
	columns := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notNull, pk int
		var dflt any
		if rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk) == nil {
			columns[name] = true
		}
	}
	return columns
}

func gooseReadSessionRow(db *sql.DB, sessionID string) map[string]any {
	available := gooseTableColumns(db, "sessions")
	if !available["id"] {
		return nil
	}
	columns := []string{}
	selects := []string{}
	for _, name := range gooseSessionColumns {
		if available[name] {
			columns = append(columns, name)
			// TIMESTAMP-declared columns must surface their stored text
			// exactly as written, not a driver-level time conversion.
			if name == "created_at" || name == "updated_at" {
				selects = append(selects, fmt.Sprintf("CAST(%s AS TEXT) AS %s", name, name))
			} else {
				selects = append(selects, name)
			}
		}
	}
	row := db.QueryRow(fmt.Sprintf("SELECT %s FROM sessions WHERE id = ?", strings.Join(selects, ", ")), sessionID)
	values := make([]any, len(columns))
	pointers := make([]any, len(columns))
	for i := range values {
		pointers[i] = &values[i]
	}
	if row.Scan(pointers...) != nil {
		return nil
	}
	session := map[string]any{}
	for i, name := range columns {
		session[name] = values[i]
	}
	return session
}

func gooseReadMessageRows(db *sql.DB, sessionID string, afterRowID int64) []gooseMessageRow {
	available := gooseTableColumns(db, "messages")
	for _, required := range []string{"id", "role", "content_json", "created_timestamp"} {
		if !available[required] {
			return nil
		}
	}
	hasMessageID := available["message_id"]
	hasMetadata := available["metadata_json"]
	columns := []string{"id", "role", "content_json", "created_timestamp"}
	if hasMessageID {
		columns = append(columns, "message_id")
	}
	if hasMetadata {
		columns = append(columns, "metadata_json")
	}
	rows, err := db.Query(fmt.Sprintf(
		"SELECT %s FROM messages WHERE session_id = ? AND id > ? ORDER BY id",
		strings.Join(columns, ", ")), sessionID, afterRowID)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	out := []gooseMessageRow{}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if rows.Scan(pointers...) != nil {
			return nil
		}
		record := gooseMessageRow{hasMessageID: hasMessageID, hasMetadata: hasMetadata}
		for i, name := range columns {
			switch name {
			case "id":
				if v, ok := values[i].(int64); ok {
					record.rowID = v
				}
			case "role":
				record.role, _ = values[i].(string)
			case "content_json":
				record.contentJSON, _ = values[i].(string)
			case "created_timestamp":
				record.createdTimestamp = values[i]
			case "message_id":
				record.messageID = values[i]
			case "metadata_json":
				record.metadataJSON, _ = values[i].(string)
			}
		}
		out = append(out, record)
	}
	return out
}

// ---------------------------------------------------------------------------
// Export and discovery
// ---------------------------------------------------------------------------

// gooseExportSession appends new rows for the session to its JSONL mirror.
// The mirror only ever grows, which keeps byte offsets and acknowledged
// checkpoints valid across calls. Returns the mirror path and working dir,
// or "" when nothing is readable yet.
func gooseExportSession(sessionID, home string, finalize bool) (string, string) {
	if sessionID == "" {
		return "", ""
	}
	dbPath := gooseSessionsDB(home)
	path := gooseMirrorPath(sessionID, home)
	existing := ""
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		existing = path
	}
	if info, err := os.Stat(dbPath); err != nil || info.IsDir() {
		return existing, ""
	}

	exportedRowID, alreadyFinal := gooseMirrorState(path)
	db, err := gooseConnect(dbPath)
	if err != nil {
		return existing, ""
	}
	defer func() { _ = db.Close() }()
	session := gooseReadSessionRow(db, sessionID)
	if session == nil {
		return existing, ""
	}
	records := []*pyObject{}
	for _, row := range gooseReadMessageRows(db, sessionID, exportedRowID) {
		records = append(records, gooseMessageRecord(row, sessionID))
	}
	workingDir := gooseStr(session, "working_dir")
	if existing == "" {
		records = append([]*pyObject{gooseSessionRecord(session)}, records...)
	}
	if finalize && !alreadyFinal {
		records = append(records, gooseSessionEndRecord(session))
	}
	if len(records) == 0 {
		return path, workingDir
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return existing, ""
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return existing, ""
	}
	defer func() { _ = file.Close() }()
	for _, record := range records {
		if _, err := file.WriteString(pyDumps(record) + "\n"); err != nil {
			return existing, ""
		}
	}
	return path, workingDir
}

// discoverGoose lists recently updated sessions and refreshes their mirrors
// when the database advanced past the last export.
func discoverGoose(home string, sinceHours int) ([]Source, error) {
	dbPath := gooseSessionsDB(home)
	if info, err := os.Stat(dbPath); err != nil || info.IsDir() {
		return []Source{}, nil
	}
	db, err := gooseConnect(dbPath)
	if err != nil {
		return []Source{}, nil
	}
	defer func() { _ = db.Close() }()
	available := gooseTableColumns(db, "sessions")
	if !available["id"] {
		return []Source{}, nil
	}
	parent := "NULL AS parent_session_id"
	if available["parent_session_id"] {
		parent = "parent_session_id"
	}
	cutoff := time.Now().Add(-time.Duration(sinceHours) * time.Hour).Unix()
	rows, err := db.Query(fmt.Sprintf(
		"SELECT id, working_dir, %s, CAST(strftime('%%s', updated_at) AS INTEGER) AS updated_epoch FROM sessions "+
			"WHERE updated_at >= datetime(?, 'unixepoch') ORDER BY updated_at DESC", parent), cutoff)
	if err != nil {
		return []Source{}, nil
	}
	defer func() { _ = rows.Close() }()
	type sessionRow struct {
		id, workingDir string
		parentID       *string
		updatedEpoch   int64
	}
	sessionRows := []sessionRow{}
	for rows.Next() {
		var record sessionRow
		var workingDir sql.NullString
		var parentID sql.NullString
		var epoch sql.NullInt64
		if rows.Scan(&record.id, &workingDir, &parentID, &epoch) != nil {
			continue
		}
		record.workingDir = workingDir.String
		if parentID.Valid {
			record.parentID = &parentID.String
		}
		record.updatedEpoch = epoch.Int64
		sessionRows = append(sessionRows, record)
	}
	sources := []Source{}
	for _, record := range sessionRows {
		path := gooseMirrorPath(record.id, home)
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || !info.ModTime().After(time.Unix(record.updatedEpoch, 0)) {
			mirrored, _ := gooseExportSession(record.id, home, false)
			if mirrored == "" {
				continue
			}
			path = mirrored
		}
		sources = append(sources, Source{
			Harness: "goose", SessionID: record.id, Path: path,
			CWD: record.workingDir, ParentSessionID: record.parentID,
		})
	}
	return sources, nil
}
