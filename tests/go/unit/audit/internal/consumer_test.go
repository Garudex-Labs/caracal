// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit consumer unit tests: parsing, HMAC verification, OCSF mapping, transient classifier.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/rs/zerolog"
)

func TestUnmarshalEventMissingRequired(t *testing.T) {
	if _, err := unmarshalEvent(`{"id":"a"}`); err == nil {
		t.Error("want error for missing required fields")
	}
}

func TestUnmarshalEventValid(t *testing.T) {
	raw := `{"id":"a","zone_id":"z","event_type":"t","occurred_at":"2026-01-01T00:00:00Z"}`
	ev, err := unmarshalEvent(raw)
	if err != nil {
		t.Fatal(err)
	}
	if ev.ID != "a" || ev.ZoneID != "z" {
		t.Errorf("unexpected event: %+v", ev)
	}
}

func TestUnmarshalEventMalformedJSON(t *testing.T) {
	if _, err := unmarshalEvent(`not-json{{{`); err == nil {
		t.Error("want error for malformed JSON")
	}
}

func TestVerifyHMACUnsignedAccepts(t *testing.T) {
	c := &Consumer{log: zerolog.Nop()}
	if !c.verifyHMAC("payload", "") {
		t.Error("unsigned mode must accept any sig")
	}
}

func TestVerifyHMACMatch(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	c := &Consumer{log: zerolog.Nop(), hmacKey: key}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("payload"))
	sig := hex.EncodeToString(mac.Sum(nil))
	if !c.verifyHMAC("payload", sig) {
		t.Error("matching sig must verify")
	}
}

func TestVerifyHMACMismatch(t *testing.T) {
	c := &Consumer{log: zerolog.Nop(), hmacKey: []byte("k")}
	if c.verifyHMAC("payload", "deadbeef") {
		t.Error("mismatched sig must not verify")
	}
	if c.verifyHMAC("payload", "") {
		t.Error("empty sig under signing mode must not verify")
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
	if out.ID != ev.ID || out.Decision != ev.Decision || out.ZoneID != ev.ZoneID {
		t.Errorf("round trip mismatch: %+v vs %+v", out, ev)
	}
}

func TestOCSFMapping(t *testing.T) {
	ev := AuditEvent{
		Decision:           "allow",
		RequestID:          "req1",
		PolicySetVersionID: "psv-1",
		OccurredAt:         time.UnixMilli(1700000000000),
	}
	ocsf := ev.toOCSF("sha", "hmac", 7)
	if ocsf.ClassUID != 6003 {
		t.Errorf("want class_uid 6003, got %d", ocsf.ClassUID)
	}
	if ocsf.ContentSHA256 != "sha" || ocsf.ChainHMAC != "hmac" || ocsf.ChainSeq != 7 {
		t.Errorf("chain fields not threaded: %+v", ocsf)
	}
	if ocsf.MetadataVersion != "1.7.0" || ocsf.ProductName != "caracal" {
		t.Errorf("metadata mismatch: %+v", ocsf)
	}
}

func TestOCSFMappingDeny(t *testing.T) {
	ev := AuditEvent{Decision: "DENY"}
	ocsf := ev.toOCSF("", "", 0)
	if ocsf.SeverityID != 2 || ocsf.ActivityID != 2 {
		t.Errorf("deny severity/activity wrong: %+v", ocsf)
	}
}

func TestIsDenyCaseInsensitive(t *testing.T) {
	for _, s := range []string{"deny", "DENY", "Deny", "dEnY"} {
		if !(AuditEvent{Decision: s}).IsDeny() {
			t.Errorf("%q must be classified deny", s)
		}
	}
	for _, s := range []string{"allow", "ALLOW", "denial", ""} {
		if (AuditEvent{Decision: s}).IsDeny() {
			t.Errorf("%q must not be classified deny", s)
		}
	}
}

func TestIsTransientPGError(t *testing.T) {
	if IsTransientPGError(nil) {
		t.Error("nil must not be transient")
	}
	if !IsTransientPGError(context.DeadlineExceeded) {
		t.Error("deadline must be transient")
	}
	if !IsTransientPGError(&pgconn.PgError{Code: "40001"}) {
		t.Error("serialization failure must be transient")
	}
	if !IsTransientPGError(&pgconn.PgError{Code: "08006"}) {
		t.Error("connection failure must be transient")
	}
	if IsTransientPGError(&pgconn.PgError{Code: "23505"}) {
		t.Error("unique violation must be permanent")
	}
	if !IsTransientPGError(errors.New("dial tcp: i/o timeout")) {
		t.Error("non-pg network error must be transient")
	}
}
