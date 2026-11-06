// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Regression tests for signed audit ingestion and replay boundaries.

package internal

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

type capturingAuditDB struct {
	event     AuditEvent
	signature string
}

func (db *capturingAuditDB) Insert(_ context.Context, event AuditEvent, signature string) (InsertResult, error) {
	db.event = event
	db.signature = signature
	return InsertResult{Inserted: true}, nil
}

func TestSignedEventIsSanitizedOnlyAfterVerification(t *testing.T) {
	raw := `{"id":"event-\u00001","zone_id":"zone-1","event_type":"token_exchange","occurred_at":"2026-01-01T00:00:00Z"}`
	key := []byte("01234567890123456789012345678901")
	db := &capturingAuditDB{}
	r := &fakeAuditRedis{}
	c := newConsumer(db, r, zerolog.Nop(), Config{ConsumerName: "audit-test", MaxDeliveries: 3, ClaimIdleSecs: 1})
	c.claimIdle = time.Millisecond
	c.auditHMACKey = key

	c.processOnce(context.Background(), redis.XMessage{
		ID:     "1-0",
		Values: map[string]any{"data": raw, "sig": auditSig(key, raw)},
	}, 1)

	if db.event.ID != "event-1" {
		t.Fatalf("verified event was not sanitized before persistence: %q", db.event.ID)
	}
	if db.signature != auditSig(key, raw) {
		t.Fatal("ingest signature changed while sanitizing the persisted event")
	}
	if len(r.acks) != 1 || len(r.dlq) != 0 {
		t.Fatalf("signed event outcome: acks=%v dlq=%#v", r.acks, r.dlq)
	}
}

func TestDLQReplayFieldsOnlyReplaysRetryableDatabaseFailures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		reason   string
		wantData bool
	}{
		{name: "transient delivery limit", reason: "transient_exceeded_max_deliveries:timeout", wantData: true},
		{name: "permanent database failure", reason: "pg_permanent_error:constraint", wantData: true},
		{name: "invalid hmac", reason: "hmac_verify_failed"},
		{name: "tamper replay", reason: "tamper_on_replay"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fields, ok := dlqReplayFields(map[string]any{
				"reason":   tc.reason,
				"src_data": validAuditEventJSON(),
				"src_sig":  "signature",
			})
			if ok != tc.wantData {
				t.Fatalf("replayable=%v, want %v; fields=%v", ok, tc.wantData, fields)
			}
			if tc.wantData && fields["data"] != validAuditEventJSON() {
				t.Fatalf("replay data = %v", fields["data"])
			}
		})
	}
}
