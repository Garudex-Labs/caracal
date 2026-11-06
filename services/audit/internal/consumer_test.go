// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit consumer recovery and health tests.

package internal

import (
	"encoding/json"
	"testing"

	"github.com/rs/zerolog"
)

func TestConsumerStartsUnhealthyUntilStreamReady(t *testing.T) {
	consumer := newConsumer(nil, nil, zerolog.Nop(), Config{})
	if consumer.Healthy() {
		t.Fatal("consumer must remain unhealthy until stream initialization succeeds")
	}
}

func TestSanitizeEventStripsNulBytes(t *testing.T) {
	ev := sanitizeEvent(AuditEvent{
		ID:           "id\x00-1",
		ZoneID:       "zone\x00-1",
		EventType:    "type-1",
		MetadataJSON: json.RawMessage(`{"key\u0000":"val\u0000ue","nested":["a\u0000b",1,true]}`),
	})
	if ev.ID != "id-1" || ev.ZoneID != "zone-1" || ev.EventType != "type-1" {
		t.Fatalf("string fields must be NUL-free, got %#v", ev)
	}
	var meta map[string]any
	if err := json.Unmarshal(ev.MetadataJSON, &meta); err != nil {
		t.Fatalf("sanitized metadata must stay valid JSON: %v", err)
	}
	nested, ok := meta["nested"].([]any)
	if !ok || meta["key"] != "value" || nested[0] != "ab" {
		t.Fatalf("metadata strings and keys must be NUL-free, got %#v", meta)
	}
}

func TestSanitizeEventLeavesCleanEventsUntouched(t *testing.T) {
	raw := json.RawMessage(`{"path":"C:\\u0000-lookalike"}`)
	ev := sanitizeEvent(AuditEvent{ID: "id-1", ZoneID: "zone-1", MetadataJSON: raw})
	var meta map[string]any
	if err := json.Unmarshal(ev.MetadataJSON, &meta); err != nil {
		t.Fatalf("metadata must stay valid JSON: %v", err)
	}
	if meta["path"] != `C:\u0000-lookalike` {
		t.Fatalf("escaped backslash sequences must survive sanitization, got %#v", meta)
	}
}
