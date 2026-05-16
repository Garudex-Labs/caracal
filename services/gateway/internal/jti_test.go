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

func TestBuildReplayAuditUsesCanonicalSignedEvent(t *testing.T) {
	key := make([]byte, 32)
	values := buildReplayAudit("audit-1", "zone-1", "req-1", json.RawMessage(`{"jti":"token-1"}`), time.Unix(1, 0).UTC(), key)
	if values["id"] != "audit-1" {
		t.Fatalf("unexpected audit id %#v", values["id"])
	}
	if values["sig"] == "" {
		t.Fatal("canonical replay audit must include audit HMAC signature")
	}
	var event struct {
		ID               string          `json:"id"`
		ZoneID           string          `json:"zone_id"`
		EventType        string          `json:"event_type"`
		Decision         string          `json:"decision"`
		EvaluationStatus string          `json:"evaluation_status"`
		MetadataJSON     json.RawMessage `json:"metadata_json"`
	}
	if err := json.Unmarshal([]byte(values["data"].(string)), &event); err != nil {
		t.Fatalf("decode audit data: %v", err)
	}
	if event.ID != "audit-1" || event.ZoneID != "zone-1" || event.EventType != "replay_detected" || event.Decision != "deny" || event.EvaluationStatus != "anomaly" {
		t.Fatalf("unexpected replay audit event %#v", event)
	}
}
