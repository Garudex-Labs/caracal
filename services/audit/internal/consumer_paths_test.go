// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit consumer stream-processing path tests.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

type fakeAuditDB struct {
	err      error
	inserted int
}

func (f *fakeAuditDB) Insert(context.Context, AuditEvent, string) (InsertResult, error) {
	f.inserted++
	return InsertResult{Inserted: f.err == nil}, f.err
}

type fakeAuditRedis struct {
	xreadGroups []auditXReadResult
	xautoClaims []auditXAutoClaimResult
	pending     []redis.XPendingExt
	groupErr    error
	ackErr      error
	xaddErr     error
	acks        []string
	dlq         []map[string]any
}

type auditXReadResult struct {
	streams []redis.XStream
	err     error
}

type auditXAutoClaimResult struct {
	messages []redis.XMessage
	next     string
	err      error
}

func (f *fakeAuditRedis) XAck(_ context.Context, _ string, _ string, ids ...string) *redis.IntCmd {
	f.acks = append(f.acks, ids...)
	return redis.NewIntResult(int64(len(ids)), f.ackErr)
}

func (f *fakeAuditRedis) XAdd(_ context.Context, args *redis.XAddArgs) *redis.StringCmd {
	if values, ok := args.Values.(map[string]any); ok {
		cp := make(map[string]any, len(values))
		for k, v := range values {
			cp[k] = v
		}
		f.dlq = append(f.dlq, cp)
	}
	return redis.NewStringResult("dlq-1", f.xaddErr)
}

func (f *fakeAuditRedis) XAutoClaim(ctx context.Context, _ *redis.XAutoClaimArgs) *redis.XAutoClaimCmd {
	cmd := redis.NewXAutoClaimCmd(ctx)
	if len(f.xautoClaims) == 0 {
		cmd.SetVal(nil, "0-0")
		return cmd
	}
	result := f.xautoClaims[0]
	f.xautoClaims = f.xautoClaims[1:]
	if result.err != nil {
		cmd.SetErr(result.err)
		return cmd
	}
	cmd.SetVal(result.messages, result.next)
	return cmd
}

func (f *fakeAuditRedis) XGroupCreateMkStream(context.Context, string, string, string) *redis.StatusCmd {
	return redis.NewStatusResult("OK", f.groupErr)
}

func (f *fakeAuditRedis) XPendingExt(ctx context.Context, _ *redis.XPendingExtArgs) *redis.XPendingExtCmd {
	cmd := redis.NewXPendingExtCmd(ctx)
	cmd.SetVal(f.pending)
	return cmd
}

func (f *fakeAuditRedis) XReadGroup(context.Context, *redis.XReadGroupArgs) *redis.XStreamSliceCmd {
	if len(f.xreadGroups) == 0 {
		return redis.NewXStreamSliceCmdResult(nil, redis.Nil)
	}
	result := f.xreadGroups[0]
	f.xreadGroups = f.xreadGroups[1:]
	return redis.NewXStreamSliceCmdResult(result.streams, result.err)
}

func (f *fakeAuditRedis) ConfigGet(context.Context, string) *redis.MapStringStringCmd {
	return redis.NewMapStringStringResult(map[string]string{"maxmemory-policy": "noeviction"}, nil)
}

func validAuditEventJSON() string {
	return `{"id":"event-1","zone_id":"zone-1","event_type":"token_exchange","request_id":"req-1","decision":"allow","evaluation_status":"complete","determining_policies_json":[],"diagnostics_json":[],"occurred_at":"2026-01-01T00:00:00Z"}`
}

func auditSig(key []byte, raw string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(raw))
	return hex.EncodeToString(mac.Sum(nil))
}

func auditConsumer(db *fakeAuditDB, r *fakeAuditRedis) *Consumer {
	return &Consumer{
		db:           db,
		redis:        r,
		log:          zerolog.Nop(),
		consumerName: "audit-test",
		maxDeliv:     3,
		claimIdle:    time.Millisecond,
	}
}

func TestProcessOnceClassifiesMalformedMessages(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values map[string]any
		reason string
	}{
		{name: "missing data", values: map[string]any{}, reason: "missing_data_field"},
		{name: "invalid json", values: map[string]any{"data": "{"}, reason: "json_parse_error:"},
		{name: "missing required fields", values: map[string]any{"data": `{"id":"event-1"}`}, reason: "json_parse_error:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeAuditRedis{}
			c := auditConsumer(&fakeAuditDB{}, r)

			c.processOnce(context.Background(), redis.XMessage{ID: "1-0", Values: tc.values}, 1)

			if len(r.acks) != 1 || r.acks[0] != "1-0" {
				t.Fatalf("acks = %v", r.acks)
			}
			if len(r.dlq) != 1 || !strings.HasPrefix(r.dlq[0]["reason"].(string), tc.reason) {
				t.Fatalf("dlq = %#v, want reason prefix %q", r.dlq, tc.reason)
			}
		})
	}
}

func TestProcessOnceRejectsInvalidHMAC(t *testing.T) {
	r := &fakeAuditRedis{}
	c := auditConsumer(&fakeAuditDB{}, r)
	c.auditHMACKey = []byte("01234567890123456789012345678901")

	c.processOnce(context.Background(), redis.XMessage{
		ID:     "1-0",
		Values: map[string]any{"data": validAuditEventJSON(), "sig": "bad"},
	}, 1)

	if c.hmacFailTotal.Load() != 1 {
		t.Fatalf("hmac failures = %d, want 1", c.hmacFailTotal.Load())
	}
	if len(r.dlq) != 1 || r.dlq[0]["reason"] != "hmac_verify_failed" {
		t.Fatalf("dlq = %#v", r.dlq)
	}
	if len(r.acks) != 1 {
		t.Fatalf("acks = %v", r.acks)
	}
}

func TestProcessOnceHandlesInsertOutcomes(t *testing.T) {
	raw := validAuditEventJSON()
	for _, tc := range []struct {
		name       string
		err        error
		deliveries int64
		wantAck    bool
		wantDLQ    string
		wantTamper int64
	}{
		{name: "insert success", err: nil, deliveries: 1, wantAck: true},
		{name: "tamper replay", err: ErrConflictMismatch, deliveries: 1, wantAck: true, wantDLQ: "tamper_on_replay", wantTamper: 1},
		{name: "transient pending retry", err: context.DeadlineExceeded, deliveries: 1},
		{name: "transient exceeded", err: context.DeadlineExceeded, deliveries: 3, wantAck: true, wantDLQ: "transient_exceeded_max_deliveries:"},
		{name: "permanent database error", err: &pgconn.PgError{Code: "23505", Message: "unique violation"}, deliveries: 1, wantAck: true, wantDLQ: "pg_permanent_error:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeAuditRedis{}
			c := auditConsumer(&fakeAuditDB{err: tc.err}, r)

			c.processOnce(context.Background(), redis.XMessage{ID: "1-0", Values: map[string]any{"data": raw, "sig": "sig"}}, tc.deliveries)

			if (len(r.acks) == 1) != tc.wantAck {
				t.Fatalf("acks = %v, wantAck=%v", r.acks, tc.wantAck)
			}
			if tc.wantDLQ == "" {
				if len(r.dlq) != 0 {
					t.Fatalf("unexpected dlq = %#v", r.dlq)
				}
			} else if len(r.dlq) != 1 || !strings.HasPrefix(r.dlq[0]["reason"].(string), tc.wantDLQ) {
				t.Fatalf("dlq = %#v, want prefix %q", r.dlq, tc.wantDLQ)
			}
			if c.tamperReplay.Load() != tc.wantTamper {
				t.Fatalf("tamper replay = %d, want %d", c.tamperReplay.Load(), tc.wantTamper)
			}
		})
	}
}

func TestProcessOnceAcceptsValidHMAC(t *testing.T) {
	raw := validAuditEventJSON()
	key := []byte("01234567890123456789012345678901")
	r := &fakeAuditRedis{}
	db := &fakeAuditDB{}
	c := auditConsumer(db, r)
	c.auditHMACKey = key

	c.processOnce(context.Background(), redis.XMessage{
		ID:     "1-0",
		Values: map[string]any{"data": raw, "sig": auditSig(key, raw)},
	}, 1)

	if db.inserted != 1 || len(r.acks) != 1 || len(r.dlq) != 0 {
		t.Fatalf("inserted=%d acks=%v dlq=%#v", db.inserted, r.acks, r.dlq)
	}
}

func TestDrainReapAndRunUseStreamLifecycle(t *testing.T) {
	raw := validAuditEventJSON()
	r := &fakeAuditRedis{
		xreadGroups: []auditXReadResult{
			{streams: []redis.XStream{{Messages: []redis.XMessage{{ID: "1-0", Values: map[string]any{"data": raw}}}}}},
			{err: redis.Nil},
		},
	}
	c := auditConsumer(&fakeAuditDB{}, r)
	if err := c.drainPEL(context.Background()); err != nil {
		t.Fatalf("drainPEL: %v", err)
	}
	if len(r.acks) != 1 {
		t.Fatalf("drain acks = %v", r.acks)
	}

	r = &fakeAuditRedis{
		xautoClaims: []auditXAutoClaimResult{{messages: []redis.XMessage{{ID: "2-0", Values: map[string]any{"data": raw}}}, next: "0-0"}},
		pending:     []redis.XPendingExt{{ID: "2-0", RetryCount: 2}},
	}
	c = auditConsumer(&fakeAuditDB{}, r)
	c.reapOnce(context.Background())
	if c.retriesTotal.Load() != 1 || len(r.acks) != 1 {
		t.Fatalf("retries=%d acks=%v", c.retriesTotal.Load(), r.acks)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.drainPEL(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled drain = %v", err)
	}
	c.reapOnce(ctx)
	c.reapLoop(ctx)
	c.Run(ctx)
}

func TestAuditConsumerRedisErrorsAreHandled(t *testing.T) {
	c := auditConsumer(&fakeAuditDB{}, &fakeAuditRedis{groupErr: errors.New("redis down")})
	if err := ensureGroup(context.Background(), c.redis, auditStream, consumerGroup); err == nil {
		t.Fatal("expected ensureGroup error")
	}

	c = auditConsumer(&fakeAuditDB{}, &fakeAuditRedis{groupErr: errors.New("BUSYGROUP already exists")})
	if err := ensureGroup(context.Background(), c.redis, auditStream, consumerGroup); err != nil {
		t.Fatalf("busy group should be ignored: %v", err)
	}

	r := &fakeAuditRedis{ackErr: errors.New("ack failed"), xaddErr: errors.New("dlq failed")}
	c = auditConsumer(&fakeAuditDB{}, r)
	c.toDLQ(context.Background(), redis.XMessage{ID: "1-0", Values: map[string]any{"data": "raw"}}, "reason")
	c.ack(context.Background(), "1-0")
	if len(r.dlq) != 1 || len(r.acks) != 1 {
		t.Fatalf("dlq=%#v acks=%v", r.dlq, r.acks)
	}
}

func TestRunProcessesLiveMessagesUntilCanceled(t *testing.T) {
	raw := validAuditEventJSON()
	ctx, cancel := context.WithCancel(context.Background())
	r := &fakeAuditRedis{xreadGroups: []auditXReadResult{
		{err: redis.Nil},
		{streams: []redis.XStream{{Messages: []redis.XMessage{{ID: "1-0", Values: map[string]any{"data": raw}}}}}},
	}}
	c := auditConsumer(&fakeAuditDB{}, r)
	c.claimIdle = time.Hour
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	c.Run(ctx)

	if !c.Healthy() {
		t.Fatal("consumer should be healthy after stream setup")
	}
	if len(r.acks) != 1 || r.acks[0] != "1-0" {
		t.Fatalf("live acks = %v", r.acks)
	}
}

func TestRunHandlesReadErrorsUntilCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &fakeAuditRedis{xreadGroups: []auditXReadResult{
		{err: redis.Nil},
		{err: errors.New("redis unavailable")},
	}}
	c := auditConsumer(&fakeAuditDB{}, r)
	c.claimIdle = time.Hour
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	c.Run(ctx)

	if c.Healthy() {
		t.Fatal("consumer should mark unhealthy after read error")
	}
}
