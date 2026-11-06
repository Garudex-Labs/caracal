// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Consumer DLQ durability tests: a message is acked only when durably handled.

package internal

import (
	"context"
	"errors"
	"testing"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

type stubInserter struct {
	err error
}

func (s stubInserter) Insert(context.Context, AuditEvent, string) (InsertResult, error) {
	return InsertResult{}, s.err
}

// dlqRedis is a minimal auditStreamClient that records XADD/XACK calls and can
// force the DLQ publish to fail.
type dlqRedis struct {
	xaddErr  error
	xaddN    int
	ackedIDs []string
}

func (r *dlqRedis) XAck(_ context.Context, _, _ string, ids ...string) *redis.IntCmd {
	cmd := redis.NewIntCmd(context.Background())
	r.ackedIDs = append(r.ackedIDs, ids...)
	cmd.SetVal(int64(len(ids)))
	return cmd
}

func (r *dlqRedis) XAdd(_ context.Context, _ *redis.XAddArgs) *redis.StringCmd {
	cmd := redis.NewStringCmd(context.Background())
	r.xaddN++
	if r.xaddErr != nil {
		cmd.SetErr(r.xaddErr)
	} else {
		cmd.SetVal("1-0")
	}
	return cmd
}

func (r *dlqRedis) XAutoClaim(context.Context, *redis.XAutoClaimArgs) *redis.XAutoClaimCmd {
	return redis.NewXAutoClaimCmd(context.Background())
}
func (r *dlqRedis) XGroupCreateMkStream(context.Context, string, string, string) *redis.StatusCmd {
	return redis.NewStatusCmd(context.Background())
}
func (r *dlqRedis) XPendingExt(context.Context, *redis.XPendingExtArgs) *redis.XPendingExtCmd {
	return redis.NewXPendingExtCmd(context.Background())
}
func (r *dlqRedis) XReadGroup(context.Context, *redis.XReadGroupArgs) *redis.XStreamSliceCmd {
	return redis.NewXStreamSliceCmd(context.Background())
}
func (r *dlqRedis) ConfigGet(context.Context, string) *redis.MapStringStringCmd {
	return redis.NewMapStringStringCmd(context.Background())
}

func newTestConsumer(db auditInserter, r auditStreamClient) *Consumer {
	return &Consumer{db: db, redis: r, log: zerolog.Nop(), maxDeliv: 5}
}

func parseFailMsg() redis.XMessage {
	return redis.XMessage{ID: "10-0", Values: map[string]any{"data": "{not json"}}
}

func TestProcessOnceDLQFailureDoesNotAck(t *testing.T) {
	r := &dlqRedis{xaddErr: errors.New("redis down")}
	c := newTestConsumer(stubInserter{}, r)
	c.processOnce(context.Background(), parseFailMsg(), 1)
	if r.xaddN != 1 {
		t.Fatalf("expected 1 DLQ attempt, got %d", r.xaddN)
	}
	if len(r.ackedIDs) != 0 {
		t.Fatalf("expected no ack when DLQ write fails, got acks %v", r.ackedIDs)
	}
	if got := c.dlqTotal.Load(); got != 0 {
		t.Fatalf("expected dlq counter unchanged on failure, got %d", got)
	}
}

func TestProcessOnceDLQSuccessAcks(t *testing.T) {
	r := &dlqRedis{}
	c := newTestConsumer(stubInserter{}, r)
	c.processOnce(context.Background(), parseFailMsg(), 1)
	if r.xaddN != 1 {
		t.Fatalf("expected 1 DLQ attempt, got %d", r.xaddN)
	}
	if len(r.ackedIDs) != 1 || r.ackedIDs[0] != "10-0" {
		t.Fatalf("expected ack of the dead-lettered id, got %v", r.ackedIDs)
	}
	if got := c.dlqTotal.Load(); got != 1 {
		t.Fatalf("expected dlq counter 1 on success, got %d", got)
	}
}

func TestProcessOncePermanentPGErrorDLQFailureRetains(t *testing.T) {
	r := &dlqRedis{xaddErr: errors.New("redis down")}
	// A non-transient PG error routes to the DLQ; a failed DLQ write must retain.
	c := newTestConsumer(stubInserter{err: errors.New("constraint violation")}, r)
	msg := redis.XMessage{ID: "20-0", Values: map[string]any{
		"data": `{"id":"e1","zone_id":"z1","event_type":"t","occurred_at":"2026-01-01T00:00:00Z"}`,
	}}
	c.processOnce(context.Background(), msg, 1)
	if len(r.ackedIDs) != 0 {
		t.Fatalf("expected no ack when DLQ write fails for permanent error, got %v", r.ackedIDs)
	}
}
