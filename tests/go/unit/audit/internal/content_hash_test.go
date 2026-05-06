// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit content hash and OCSF mapping unit tests.

package internal

import (
	"encoding/json"
	"testing"
	"time"
)

func baseEvent() AuditEvent {
	return AuditEvent{
		ID:                 "ev-1",
		ZoneID:             "zone1",
		EventType:          "token_exchange",
		RequestID:          "req1",
		Decision:           "allow",
		PolicySetID:        "ps-1",
		PolicySetVersionID: "psv-1",
		ManifestSHA:        "abc123",
		EvaluationStatus:   "complete",
		OccurredAt:         time.UnixMilli(1700000000000).UTC(),
	}
}

func TestContentHashDeterminism(t *testing.T) {
	ev := baseEvent()
	if contentHash(ev) != contentHash(ev) {
		t.Error("hash must be deterministic")
	}
}

func TestContentHashSensitiveFields(t *testing.T) {
	cases := map[string]func(*AuditEvent){
		"Decision":           func(e *AuditEvent) { e.Decision = "deny" },
		"ZoneID":             func(e *AuditEvent) { e.ZoneID = "zone-other" },
		"EventType":          func(e *AuditEvent) { e.EventType = "other" },
		"RequestID":          func(e *AuditEvent) { e.RequestID = "req-other" },
		"PolicySetID":        func(e *AuditEvent) { e.PolicySetID = "other" },
		"PolicySetVersionID": func(e *AuditEvent) { e.PolicySetVersionID = "other" },
		"ManifestSHA":        func(e *AuditEvent) { e.ManifestSHA = "other" },
		"EvaluationStatus":   func(e *AuditEvent) { e.EvaluationStatus = "error" },
		"OccurredAt":         func(e *AuditEvent) { e.OccurredAt = e.OccurredAt.Add(time.Nanosecond) },
		"DeterminingPolicies": func(e *AuditEvent) {
			e.DeterminingPoliciesJSON = json.RawMessage(`["p1"]`)
		},
		"Diagnostics": func(e *AuditEvent) { e.DiagnosticsJSON = json.RawMessage(`{"k":1}`) },
		"Metadata":    func(e *AuditEvent) { e.MetadataJSON = json.RawMessage(`{"k":1}`) },
	}
	base := baseEvent()
	h := contentHash(base)
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			ev := base
			mut(&ev)
			if contentHash(ev) == h {
				t.Errorf("hash unchanged when %s mutated", name)
			}
		})
	}
}

func TestContentHashEmptyEqualsNullJSON(t *testing.T) {
	a := baseEvent()
	b := baseEvent()
	b.DeterminingPoliciesJSON = json.RawMessage("null")
	if contentHash(a) != contentHash(b) {
		t.Error("empty raw json and 'null' must hash identically")
	}
}

func TestContentHashShape(t *testing.T) {
	h := contentHash(baseEvent())
	if len(h) != 64 {
		t.Errorf("SHA-256 hex must be 64 chars, got %d", len(h))
	}
}
