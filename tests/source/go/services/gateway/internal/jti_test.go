// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway JTI replay audit tests.

package internal

import (
	"encoding/json"
	"testing"
	"time"
)

func TestBuildReplayAuditProducesCanonicalEvent(t *testing.T) {
	event := buildReplayAudit("audit-1", "zone-1", "req-1", json.RawMessage(`{"jti":"token-1"}`), time.Unix(1, 0).UTC())
	if event.ID != "audit-1" || event.ZoneID != "zone-1" || event.RequestID != "req-1" {
		t.Fatalf("unexpected replay audit identity %#v", event)
	}
	if event.EventType != "replay_detected" || event.Decision != "deny" || event.EvaluationStatus != "anomaly" {
		t.Fatalf("unexpected replay audit classification %#v", event)
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatalf("decode audit metadata: %v", err)
	}
	if meta["jti"] != "token-1" {
		t.Fatalf("unexpected replay audit metadata %#v", meta)
	}
}
