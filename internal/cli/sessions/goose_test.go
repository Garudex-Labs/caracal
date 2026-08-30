// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const gooseAlphaGolden = `{"type": "session", "session_id": "gs-alpha 01", "name": "descr fallback", "session_type": "user", "working_dir": "/tmp/wd one", "parent_session_id": null, "schedule_id": null, "goose_mode": "auto", "provider": "openai", "model": "gpt-x-mini", "timestamp": "2026-08-29T07:00:00Z"}
{"type": "message", "row_id": 1, "session_id": "gs-alpha 01", "message_id": "m-1", "role": "user", "timestamp": "2024-04-05T19:34:38.901Z", "content": [{"type": "text", "text": "héllo\n\"wörld\" \\ \u0001 ✓", "z": 1, "a": [2, 3, {"y": true, "x": null}]}], "metadata": {"b": 2, "a": {"nested": [1.5, -0.25, 1000.0]}}}
{"type": "message", "row_id": 2, "session_id": "gs-alpha 01", "message_id": null, "role": "assistant", "timestamp": "2024-04-05T19:34:39.000Z", "content": {"toolCalls": []}, "metadata": {}}
{"type": "message", "row_id": 3, "session_id": "gs-alpha 01", "message_id": "m-3", "role": "assistant", "timestamp": "2024-04-05T19:34:39.250Z", "content": [], "metadata": []}
{"type": "message", "row_id": 9, "session_id": "gs-alpha 01", "message_id": "m-9", "role": "assistant", "timestamp": "2024-04-05T19:35:00.500Z", "content": [{"type": "toolConfirmationRequest", "cost": 0.000125, "big": 1e+16, "mid": 1000000000000000.0}], "metadata": {}}
{"type": "session_end", "session_id": "gs-alpha 01", "timestamp": "2026-08-29T07:00:00Z", "usage": {"inputTokens": 400, "outputTokens": 500, "totalTokens": 900, "cost": 1.75}}
`

const gooseBetaGolden = `{"type": "session", "session_id": "gs-béta/02", "name": "named", "session_type": "scheduled", "working_dir": "", "parent_session_id": "gs-alpha 01", "schedule_id": "sch-9", "goose_mode": "", "provider": "", "model": "", "timestamp": "2026-01-02T03:04:05Z"}
{"type": "message", "row_id": 4, "session_id": "gs-béta/02", "message_id": "m-4", "role": "user", "timestamp": "2024-04-05T19:34:40.123Z", "content": [], "metadata": {"emoji": "🎯", "int": 9007199254740991}}
{"type": "session_end", "session_id": "gs-béta/02", "timestamp": "2026-08-29T07:00:00Z", "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 11, "cost": null}}
`

func buildGooseFixture(t *testing.T, home string) {
	t.Helper()
	dbDir := filepath.Join(home, ".local", "share", "goose", "sessions")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dbDir, "sessions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	statements := []string{
		`CREATE TABLE sessions (
		  id TEXT PRIMARY KEY, name TEXT, description TEXT, session_type TEXT,
		  working_dir TEXT, created_at TIMESTAMP, updated_at TIMESTAMP,
		  total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
		  accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER,
		  accumulated_output_tokens INTEGER, accumulated_cost REAL,
		  provider_name TEXT, model_config_json TEXT, goose_mode TEXT,
		  parent_session_id TEXT, schedule_id TEXT)`,
		`CREATE TABLE messages (
		  id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT, role TEXT,
		  content_json TEXT, created_timestamp INTEGER, metadata_json TEXT)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	sessions := [][]any{
		{"gs-alpha 01", nil, "descr fallback", nil, "/tmp/wd one",
			"2026-08-29 07:00:00", "2026-08-29 07:00:00",
			0, 5, 7, 900, 400, 500, 1.75, "openai",
			`{"model": "gpt-x", "model_name": "gpt-x-mini", "temp": 0.5}`, "auto", nil, nil},
		{"gs-béta/02", "named", nil, "scheduled", nil,
			"2026-01-02 03:04:05", "2026-08-29 07:00:00",
			11, 0, 0, 0, 0, 0, nil, "", "not json {", "", "gs-alpha 01", "sch-9"},
	}
	for _, row := range sessions {
		if _, err := db.Exec(
			"INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row...); err != nil {
			t.Fatal(err)
		}
	}
	messages := [][]any{
		{1, "gs-alpha 01", "m-1", "user",
			`[{"type":"text","text":"héllo\n\"wörld\" \\ \u0001 ✓","z":1,"a":[2,3,{"y":true,"x":null}]}]`,
			1712345678901, `{"b":2,"a":{"nested":[1.5,-0.25,1e3]}}`},
		{2, "gs-alpha 01", nil, "assistant", `{"toolCalls":[]}`, 1712345679, nil},
		{3, "gs-alpha 01", "m-3", "assistant", "not-json", "1712345679.25", `[]`},
		{4, "gs-béta/02", "m-4", "user", `[]`, 1712345680123,
			`{"emoji":"🎯","int":9007199254740991}`},
		{9, "gs-alpha 01", "m-9", "assistant",
			`[{"type":"toolConfirmationRequest","cost":0.000125,"big":1e16,"mid":1e15}]`,
			1712345700500, `{}`},
	}
	for _, row := range messages {
		if _, err := db.Exec("INSERT INTO messages VALUES (?,?,?,?,?,?,?)", row...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGooseExportSessionGolden(t *testing.T) {
	home := t.TempDir()
	buildGooseFixture(t, home)
	cases := []struct {
		sessionID, mirror, golden, workingDir string
	}{
		{"gs-alpha 01", "gs-alpha_01.jsonl", gooseAlphaGolden, "/tmp/wd one"},
		{"gs-béta/02", "gs-béta_02.jsonl", gooseBetaGolden, ""},
	}
	for _, tc := range cases {
		path, workingDir := gooseExportSession(tc.sessionID, home, true)
		if filepath.Base(path) != tc.mirror {
			t.Fatalf("mirror path %q, want base %q", path, tc.mirror)
		}
		if workingDir != tc.workingDir {
			t.Fatalf("working dir %q, want %q", workingDir, tc.workingDir)
		}
		blob, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(blob) != tc.golden {
			t.Fatalf("mirror mismatch for %s:\n got: %q\nwant: %q", tc.sessionID, blob, tc.golden)
		}
		// A second finalize must not duplicate rows or the end record.
		if _, _ = gooseExportSession(tc.sessionID, home, true); true {
			again, _ := os.ReadFile(path)
			if string(again) != tc.golden {
				t.Fatalf("finalize is not idempotent for %s", tc.sessionID)
			}
		}
	}
}

func TestDiscoverGoose(t *testing.T) {
	home := t.TempDir()
	buildGooseFixture(t, home)
	db, err := sql.Open("sqlite", filepath.Join(home, ".local", "share", "goose", "sessions", "sessions.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE sessions SET updated_at = datetime('now')"); err != nil {
		t.Fatal(err)
	}
	sources, err := discoverGoose(home, 24)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 2 {
		t.Fatalf("got %d sources, want 2", len(sources))
	}
	for _, source := range sources {
		if source.Harness != "goose" {
			t.Fatalf("harness %q", source.Harness)
		}
		if _, err := os.Stat(source.Path); err != nil {
			t.Fatalf("mirror missing: %v", err)
		}
	}
	byID := map[string]Source{}
	for _, source := range sources {
		byID[source.SessionID] = source
	}
	alpha := byID["gs-alpha 01"]
	if alpha.CWD != "/tmp/wd one" || alpha.ParentSessionID != nil {
		t.Fatalf("alpha source: %+v", alpha)
	}
	beta := byID["gs-béta/02"]
	if beta.ParentSessionID == nil || *beta.ParentSessionID != "gs-alpha 01" {
		t.Fatalf("beta parent: %+v", beta)
	}
	// Discovery must not finalize.
	blob, _ := os.ReadFile(alpha.Path)
	if strings.Contains(string(blob), "session_end") {
		t.Fatal("discovery wrote a session_end record")
	}
	// Sessions outside the window disappear.
	if _, err := db.Exec("UPDATE sessions SET updated_at = '2020-01-01 00:00:00'"); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	empty, err := discoverGoose(home, 24)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("window filter failed: %d sources", len(empty))
	}
}

func TestGooseSafeSessionID(t *testing.T) {
	if got := gooseSafeSessionID("a b/c:d"); got != "a_b_c_d" {
		t.Fatalf("got %q", got)
	}
	if got := gooseSafeSessionID(strings.Repeat("x", 200)); len(got) != 128 {
		t.Fatalf("length %d", len(got))
	}
}

func TestGooseTimestamps(t *testing.T) {
	if got := gooseISOTimestamp(int64(1712345678901)); got != "2024-04-05T19:34:38.901Z" {
		t.Fatalf("ms epoch: %q", got)
	}
	if got := gooseISOTimestamp("1712345679.25"); got != "2024-04-05T19:34:39.250Z" {
		t.Fatalf("string epoch: %q", got)
	}
	if got := gooseISOTimestamp("nonsense"); got != "" {
		t.Fatalf("bad epoch: %q", got)
	}
	if got := gooseSQLTimestamp("2026-01-02 03:04:05"); got != "2026-01-02T03:04:05Z" {
		t.Fatalf("sql ts: %q", got)
	}
	if got := gooseSQLTimestamp("2026-01-02T03:04:05+02:00"); got != "2026-01-02T03:04:05+02:00" {
		t.Fatalf("offset ts: %q", got)
	}
	if got := gooseSQLTimestamp(nil); got != "" {
		t.Fatalf("nil ts: %q", got)
	}
}

func TestPyFloatFormatting(t *testing.T) {
	cases := map[float64]string{
		1000.0:   "1000.0",
		1e15:     "1000000000000000.0",
		1e16:     "1e+16",
		1.5:      "1.5",
		-0.25:    "-0.25",
		0.0001:   "0.0001",
		1e-5:     "1e-05",
		1.75:     "1.75",
		0.000125: "0.000125",
	}
	for value, want := range cases {
		var sb strings.Builder
		writePyFloat(&sb, value)
		if sb.String() != want {
			t.Fatalf("float %v: got %q, want %q", value, sb.String(), want)
		}
	}
}

func TestGooseScanState(t *testing.T) {
	blob := []byte(`{"type": "session", "session_id": "s"}
{"type": "message", "row_id": 7}
not json
{"type": "session_end", "session_id": "s"}
`)
	rowID, hasEnd := gooseScanState(blob)
	if rowID != 7 || !hasEnd {
		t.Fatalf("rowID=%d hasEnd=%v", rowID, hasEnd)
	}
}
