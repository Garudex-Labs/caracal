// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control audit sink tests.

package internal

import (
	"encoding/json"
	"testing"
	"time"
)

func TestBuildControlAuditUsesCanonicalSignedEvent(t *testing.T) {
	key := make([]byte, 32)
	values := buildControlAudit(AuditEvent{
		At:        time.Unix(1, 0).UTC(),
		ZoneID:    "zone-1",
		ClientID:  "app-1",
		Subject:   "user-1",
		JTI:       "jti-1",
		Command:   "zone",
		Sub:       "list",
		Decision:  "allow",
		RequestID: "req-1",
	}, key)
	if values["id"] != "req-1" || values["sig"] == "" {
		t.Fatalf("audit values must include id and signature: %#v", values)
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
	if event.ID != "req-1" || event.ZoneID != "zone-1" || event.EventType != "control.invoke" || event.Decision != "allow" || event.EvaluationStatus != "complete" {
		t.Fatalf("unexpected control audit event %#v", event)
	}
}
