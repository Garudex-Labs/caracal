// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for audit event mapping, HMAC chaining, and PG error classification.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestToOCSFAllowMapping(t *testing.T) {
	ev := baseEvent()
	out := toOCSF(ev, "sha", "hmac", 7)
	if out.ClassUID != 6003 || out.TypeUID != 600301 {
		t.Fatalf("OCSF class/type uids wrong: %d/%d", out.ClassUID, out.TypeUID)
	}
	if out.SeverityID != 1 || out.ActivityID != 1 {
		t.Fatalf("allow should map to severity/activity 1, got %d/%d", out.SeverityID, out.ActivityID)
	}
	if out.MetadataVersion != "1.7.0" || out.ProductName != "caracal" {
		t.Fatalf("static OCSF metadata wrong: %q %q", out.MetadataVersion, out.ProductName)
	}
	if out.ContentSHA256 != "sha" || out.ChainHMAC != "hmac" || out.ChainSeq != 7 {
		t.Fatal("forensic chain fields not carried through")
	}
	if out.Time != ev.OccurredAt.UnixMilli() {
		t.Fatalf("time must be unix millis, got %d", out.Time)
	}
}

func TestToOCSFDenyMapping(t *testing.T) {
	ev := baseEvent()
	ev.Decision = "deny"
	out := toOCSF(ev, "", "", 0)
	if out.SeverityID != 2 || out.ActivityID != 2 {
		t.Fatalf("deny should map to severity/activity 2, got %d/%d", out.SeverityID, out.ActivityID)
	}
}

func TestToOCSFRawStringFields(t *testing.T) {
	ev := baseEvent()
	ev.DeterminingPoliciesJSON = json.RawMessage(`["p1"]`)
	ev.DiagnosticsJSON = json.RawMessage(`{"k":1}`)
	out := toOCSF(ev, "", "", 0)
	if out.DeterminingPolicies != `["p1"]` || out.Diagnostics != `{"k":1}` {
		t.Fatalf("raw json fields not stringified: %q %q", out.DeterminingPolicies, out.Diagnostics)
	}
	if out.Metadata != "" {
		t.Fatalf("absent raw json must map to empty string, got %q", out.Metadata)
	}
}

func TestRawString(t *testing.T) {
	if rawString(nil) != "" {
		t.Fatal("nil raw message must be empty string")
	}
	if rawString(json.RawMessage(`{"a":1}`)) != `{"a":1}` {
		t.Fatal("non-empty raw message must pass through verbatim")
	}
}

func TestUnmarshalEventValid(t *testing.T) {
	raw := `{"id":"e1","zone_id":"z1","occurred_at":"2023-11-14T22:13:20Z","decision":"allow"}`
	ev, err := unmarshalEvent(raw)
	if err != nil {
		t.Fatalf("valid event must unmarshal: %v", err)
	}
	if ev.ID != "e1" || ev.ZoneID != "z1" {
		t.Fatalf("unmarshalled fields wrong: %+v", ev)
	}
}

func TestUnmarshalEventRejectsMissingFields(t *testing.T) {
	cases := map[string]string{
		"missing id":          `{"zone_id":"z1","occurred_at":"2023-11-14T22:13:20Z"}`,
		"missing zone":        `{"id":"e1","occurred_at":"2023-11-14T22:13:20Z"}`,
		"missing occurred_at": `{"id":"e1","zone_id":"z1"}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := unmarshalEvent(raw); err == nil {
				t.Fatal("expected required-field validation error")
			}
		})
	}
}

func TestUnmarshalEventRejectsInvalidJSON(t *testing.T) {
	if _, err := unmarshalEvent("{not json"); err == nil {
		t.Fatal("malformed JSON must error")
	}
}

func TestVerifyHMACNoKeyAlwaysTrue(t *testing.T) {
	c := &Consumer{}
	if !c.verifyHMAC("payload", "") {
		t.Fatal("no configured key must accept every payload")
	}
}

func TestVerifyHMACRoundTrip(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	c := &Consumer{auditHMACKey: key}
	raw := `{"id":"e1"}`
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(raw))
	sig := hex.EncodeToString(mac.Sum(nil))

	if !c.verifyHMAC(raw, sig) {
		t.Fatal("correct signature must verify")
	}
	if c.verifyHMAC(raw, "") {
		t.Fatal("empty signature must be rejected when a key is set")
	}
	if c.verifyHMAC(raw, "nothex") {
		t.Fatal("non-hex signature must be rejected")
	}
	if c.verifyHMAC("tampered", sig) {
		t.Fatal("signature over different bytes must not verify")
	}
}

func TestComputeHMAC(t *testing.T) {
	none := &PGWriter{}
	if none.computeHMAC("sha", "prev") != "" {
		t.Fatal("no key must yield empty chain HMAC")
	}

	key := []byte("01234567890123456789012345678901")
	w := &PGWriter{auditHMACKey: key}
	first := w.computeHMAC("shaA", "prev")
	if _, err := hex.DecodeString(first); err != nil {
		t.Fatalf("chain HMAC must be hex: %v", err)
	}
	if w.computeHMAC("shaA", "prev") != first {
		t.Fatal("chain HMAC must be deterministic")
	}
	if w.computeHMAC("shaB", "prev") == first {
		t.Fatal("chain HMAC must change with content sha")
	}
	if w.computeHMAC("shaA", "other") == first {
		t.Fatal("chain HMAC must change with previous sha")
	}
}

func TestNullableJSON(t *testing.T) {
	if nullableJSON(nil) != nil {
		t.Fatal("empty bytes must map to nil")
	}
	if nullableJSON([]byte("null")) != nil {
		t.Fatal("literal null must map to nil")
	}
	got := nullableJSON([]byte(`{"a":1}`))
	if got == nil || *got != `{"a":1}` {
		t.Fatalf("non-null json must be preserved, got %v", got)
	}
}

func TestNullEmpty(t *testing.T) {
	if nullEmpty("") != nil {
		t.Fatal("empty string must map to nil")
	}
	got := nullEmpty("v")
	if got == nil || *got != "v" {
		t.Fatalf("non-empty string must be preserved, got %v", got)
	}
}

func TestIsTransientPGError(t *testing.T) {
	if IsTransientPGError(nil) {
		t.Fatal("nil error is not transient")
	}
	if !IsTransientPGError(context.DeadlineExceeded) {
		t.Fatal("deadline exceeded is transient")
	}
	if !IsTransientPGError(context.Canceled) {
		t.Fatal("context canceled is transient")
	}

	transientCodes := []string{"40001", "40P01", "57P01", "08006", "53300"}
	for _, code := range transientCodes {
		if !IsTransientPGError(&pgconn.PgError{Code: code}) {
			t.Fatalf("pg code %s should be transient", code)
		}
	}

	if IsTransientPGError(&pgconn.PgError{Code: "23505"}) {
		t.Fatal("unique violation is a permanent error")
	}

	if !IsTransientPGError(errors.New("dial tcp: connection refused")) {
		t.Fatal("non-pg network errors are treated as transient")
	}
}
