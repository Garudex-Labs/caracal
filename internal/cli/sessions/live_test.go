// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/outbox"
)

// TestLiveDrain delivers one real batch against a running deployment.
// Gated: set CARACAL_LIVE_HOME to a directory holding an authenticated
// ~/.caracal/config.json.
func TestLiveDrain(t *testing.T) {
	home := os.Getenv("CARACAL_LIVE_HOME")
	if home == "" {
		t.Skip("CARACAL_LIVE_HOME not set")
	}
	cfg := LoadConfig(home)
	if cfg == nil || cfg.UserID == "" {
		t.Fatal("live home is not authenticated")
	}
	session := fmt.Sprintf("live-%d", time.Now().UnixNano())
	dbPath := filepath.Join(home, ".caracal", "telemetry_buffer.db")
	store, err := outbox.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{
		"session_id": session, "harness": "kiro",
		"agent_id": nil, "agent_version": nil, "layer_hash": nil,
		"lines":        []any{`{"role":"user","content":"hello"}`, `{"role":"assistant","content":"hi"}`},
		"start_offset": 0, "hook_event": "PostToolUse", "parent_session_id": nil,
		"total_offset": 68,
	}
	if _, err := store.Enqueue(payload, cfg.ServerURL, cfg.UserID, ""); err != nil {
		t.Fatal(err)
	}
	_ = store.Close()

	rejections := []Rejection{}
	drained, err := DrainOutbox(cfg, DrainOptions{Home: home, DBPath: dbPath}, &rejections, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !drained || len(rejections) != 0 {
		t.Fatalf("drained=%v rejections=%v", drained, rejections)
	}
	offset, lines, _, valid := CursorStatus(session, home)
	if !valid || lines != 2 {
		t.Fatalf("cursor offset=%d lines=%d valid=%v", offset, lines, valid)
	}
	// The server checkpoint agrees with the local cursor.
	ack := ServerCheckpoint(cfg, "kiro", session)
	if ack == nil || ack.AcknowledgedLine != 1 {
		t.Fatalf("server checkpoint = %+v", ack)
	}
	t.Logf("live drain ok: cursor offset=%d lines=%d server ack=%d", offset, lines, ack.AcknowledgedLine)
}
