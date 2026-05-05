// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit consumer unit tests: message parsing, JSON round-trip, OCSF mapping.

package internal

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

func TestConsumerHandleMissingDataField(t *testing.T) {
	c := &Consumer{
		log: zerolog.Nop(),
	}
	msg := redis.XMessage{
		ID:     "1-0",
		Values: map[string]interface{}{"other": "value"},
	}
	if err := c.handle(context.Background(), msg); err != nil {
		t.Errorf("want nil error for missing data field, got %v", err)
	}
}

func TestConsumerHandleMalformedJSON(t *testing.T) {
	c := &Consumer{
		log: zerolog.Nop(),
	}
	msg := redis.XMessage{
		ID:     "2-0",
		Values: map[string]interface{}{"data": "not-valid-json{{{"},
	}
	if err := c.handle(context.Background(), msg); err == nil {
		t.Error("want error for malformed JSON")
	}
}

func TestAuditEventJSONRoundTrip(t *testing.T) {
	ev := AuditEvent{
		ID:               "test-id-1",
		ZoneID:           "zone1",
		EventType:        "token_exchange",
		RequestID:        "req1",
		Decision:         "allow",
		EvaluationStatus: "complete",
		OccurredAt:       time.Now().UTC().Truncate(time.Millisecond),
	}
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var out AuditEvent
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != ev.ID {
		t.Errorf("ID mismatch: want %s, got %s", ev.ID, out.ID)
	}
	if out.Decision != ev.Decision {
		t.Errorf("Decision mismatch: want %s, got %s", ev.Decision, out.Decision)
	}
	if out.ZoneID != ev.ZoneID {
		t.Errorf("ZoneID mismatch: want %s, got %s", ev.ZoneID, out.ZoneID)
	}
}

func TestOCSFMapping(t *testing.T) {
	ev := AuditEvent{
		Decision:           "allow",
		RequestID:          "req1",
		PolicySetVersionID: "psv-1",
		OccurredAt:         time.UnixMilli(1700000000000),
	}
	ocsf := ev.toOCSF()
	if ocsf.ClassUID != 6003 {
		t.Errorf("want class_uid 6003, got %d", ocsf.ClassUID)
	}
	if ocsf.Decision != "allow" {
		t.Errorf("want allow, got %s", ocsf.Decision)
	}
	if ocsf.MetadataVersion != "1.7.0" {
		t.Errorf("want 1.7.0, got %s", ocsf.MetadataVersion)
	}
	if ocsf.ProductName != "caracal" {
		t.Errorf("want caracal, got %s", ocsf.ProductName)
	}
}

func TestOCSFMappingDeny(t *testing.T) {
	ev := AuditEvent{Decision: "DENY"}
	ocsf := ev.toOCSF()
	if ocsf.SeverityID != 2 {
		t.Errorf("want severity 2 for DENY, got %d", ocsf.SeverityID)
	}
	if ocsf.ActivityID != 2 {
		t.Errorf("want activity 2 for DENY, got %d", ocsf.ActivityID)
	}
}
