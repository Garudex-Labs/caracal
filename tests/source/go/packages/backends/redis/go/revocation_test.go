// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis revocation connector tests for key lookup and stream consumption.

package revocationredis

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/packages/core/go/crypto"
	"github.com/redis/go-redis/v9"
)

func TestStoreChecksAndRecordsRevokedSessions(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)

	if store.IsRevoked("sid-1") {
		t.Fatal("fresh session should not be revoked")
	}
	if err := store.MarkRevoked("sid-1", time.Hour); err != nil {
		t.Fatalf("mark revoked: %v", err)
	}
	if !store.IsRevoked("sid-1") {
		t.Fatal("stored session should be revoked")
	}
}

func TestStoreFailsClosedByDefault(t *testing.T) {
	rdb := newFakeRedis()
	rdb.getErr = errors.New("redis down")
	store := NewStore(rdb)

	if !store.IsRevoked("sid-1") {
		t.Fatal("redis lookup error should fail closed")
	}
}

func TestStoreOptionsAndBoundaryInputs(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb,
		WithKeyPrefix("rev:"),
		WithDefaultTTL(-time.Second),
		WithTimeout(0),
		WithFailClosed(false),
	)
	rdb.getErr = errors.New("redis down")

	if store.IsRevoked("") {
		t.Fatal("empty session id must not be treated as revoked")
	}
	if store.IsRevoked("sid-open") {
		t.Fatal("fail-open store should not mark lookup errors revoked")
	}
	rdb.getErr = nil
	if err := store.MarkRevoked("", time.Hour); err != nil {
		t.Fatalf("empty session mark should be a no-op: %v", err)
	}
	if len(rdb.values) != 0 {
		t.Fatalf("empty session mark wrote redis keys: %#v", rdb.values)
	}
	if err := store.MarkRevoked("sid-default-ttl", -time.Hour); err != nil {
		t.Fatalf("mark revoked with default ttl: %v", err)
	}
	if _, ok := rdb.values["rev:sid-default-ttl"]; !ok {
		t.Fatalf("custom key prefix was not used: %#v", rdb.values)
	}
	if rdb.ttls["rev:sid-default-ttl"] != DefaultRevocationTTL {
		t.Fatalf("default ttl = %s, want %s", rdb.ttls["rev:sid-default-ttl"], DefaultRevocationTTL)
	}
}

func TestStorePropagatesRedisSetErrors(t *testing.T) {
	rdb := newFakeRedis()
	rdb.setErr = errors.New("write failed")
	store := NewStore(rdb)

	if err := store.MarkRevoked("sid-1", time.Hour); err == nil || !strings.Contains(err.Error(), "write failed") {
		t.Fatalf("want redis set error, got %v", err)
	}
}

func TestConsumerMarksSignedStreamMessageAuthorityAnchors(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)
	key := []byte("0123456789abcdef0123456789abcdef")
	values := map[string]any{
		"zone_id":            "zone1",
		"session_id":         "sid-1",
		"root_sid":           "root-1",
		"agent_session_id":   "agent-1",
		"delegation_edge_id": "edge-1",
		"reason":             "grant_revoked",
	}
	values[sharedcrypto.StreamSigField] = sharedcrypto.SignStream(key, RevocationStream, values)
	rdb.messages = []redis.XMessage{{ID: "1-0", Values: values}}

	consumer, err := NewConsumer(rdb, store, "resource-1", WithStreamHMAC(key, true))
	if err != nil {
		t.Fatalf("new consumer: %v", err)
	}

	n, err := consumer.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("poll once: %v", err)
	}
	if n != 1 {
		t.Fatalf("handled %d messages, want 1", n)
	}
	if !store.IsRevoked("sid-1") {
		t.Fatal("signed stream message should mark session revoked")
	}
	for _, anchor := range []string{"root-1", "agent-1", "edge-1"} {
		if !store.IsRevoked(anchor) {
			t.Fatalf("signed stream message should mark %s revoked", anchor)
		}
	}
	if len(rdb.acked) != 1 || rdb.acked[0] != "1-0" {
		t.Fatalf("message should be acked once, got %v", rdb.acked)
	}
}

func TestNewConsumerValidationAndDefaults(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)

	for name, fn := range map[string]func() (*Consumer, error){
		"consumer":      func() (*Consumer, error) { return NewConsumer(rdb, store, "") },
		"store":         func() (*Consumer, error) { return NewConsumer(rdb, nil, "resource-1") },
		"signature-key": func() (*Consumer, error) { return NewConsumer(rdb, store, "resource-1", WithStreamHMAC(nil, true)) },
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := fn(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}

	consumer, err := NewConsumer(rdb, store, "resource-1",
		WithStream("custom.stream"),
		WithGroup("custom-group"),
		WithBatchSize(0),
		WithBlock(time.Millisecond),
		WithPendingIdle(0),
	)
	if err != nil {
		t.Fatalf("new consumer: %v", err)
	}
	if consumer.stream != "custom.stream" || consumer.group != "custom-group" {
		t.Fatalf("custom stream/group not applied: %#v", consumer)
	}
	if consumer.batchSize != 50 || consumer.pendingIdle != 30*time.Second || consumer.block != time.Millisecond {
		t.Fatalf("defaults not normalized: batch=%d idle=%s block=%s", consumer.batchSize, consumer.pendingIdle, consumer.block)
	}
}

func TestEnsureGroupIgnoresBusyGroupAndReturnsOtherErrors(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)
	consumer, err := NewConsumer(rdb, store, "resource-1")
	if err != nil {
		t.Fatalf("new consumer: %v", err)
	}

	rdb.groupErr = errors.New("BUSYGROUP Consumer Group name already exists")
	if err := consumer.EnsureGroup(context.Background()); err != nil {
		t.Fatalf("busy group should be ignored: %v", err)
	}

	rdb.groupErr = errors.New("redis unavailable")
	if err := consumer.EnsureGroup(context.Background()); err == nil {
		t.Fatal("expected non-BUSYGROUP error")
	}
}

func TestConsumerAcksInvalidSignatureWithoutMarkingSession(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)
	rdb.messages = []redis.XMessage{{ID: "1-1", Values: map[string]any{
		"session_id":                "sid-2",
		sharedcrypto.StreamSigField: "00",
	}}}

	consumer, err := NewConsumer(rdb, store, "resource-1", WithStreamHMAC([]byte("0123456789abcdef0123456789abcdef"), true))
	if err != nil {
		t.Fatalf("new consumer: %v", err)
	}

	n, err := consumer.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("poll once: %v", err)
	}
	if n != 1 {
		t.Fatalf("handled %d messages, want 1", n)
	}
	if store.IsRevoked("sid-2") {
		t.Fatal("invalid signature must not mark session revoked")
	}
	if len(rdb.acked) != 1 || rdb.acked[0] != "1-1" {
		t.Fatalf("message should be acked once, got %v", rdb.acked)
	}
}

func TestConsumerProcessesUnsignedMessagesWhenSignaturesAreOptional(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)
	rdb.messages = []redis.XMessage{{ID: "1-2", Values: map[string]any{
		"session_id": "sid-1",
		"sid":        "sid-1",
		"root_sid":   "root-1",
	}}}
	consumer, err := NewConsumer(rdb, store, "resource-1")
	if err != nil {
		t.Fatalf("new consumer: %v", err)
	}

	n, err := consumer.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("poll once: %v", err)
	}

	if n != 1 || !store.IsRevoked("sid-1") || !store.IsRevoked("root-1") {
		t.Fatalf("unsigned optional-signature message not processed, n=%d values=%#v", n, rdb.values)
	}
	if count := len(rdb.values); count != 2 {
		t.Fatalf("duplicate sid anchor should be written once, got %d values: %#v", count, rdb.values)
	}
}

func TestConsumerReplaysPendingMessages(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)
	key := []byte("0123456789abcdef0123456789abcdef")
	values := map[string]any{"zone_id": "zone1", "session_id": "sid-pending"}
	values[sharedcrypto.StreamSigField] = sharedcrypto.SignStream(key, RevocationStream, values)
	rdb.pending = []redis.XMessage{{ID: "0-1", Values: values}}

	consumer, err := NewConsumer(rdb, store, "resource-1", WithStreamHMAC(key, true))
	if err != nil {
		t.Fatalf("new consumer: %v", err)
	}

	n, err := consumer.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("poll once: %v", err)
	}
	if n != 1 {
		t.Fatalf("handled %d messages, want 1", n)
	}
	if !store.IsRevoked("sid-pending") {
		t.Fatal("pending stream message should mark session revoked")
	}
	if len(rdb.acked) != 1 || rdb.acked[0] != "0-1" {
		t.Fatalf("message should be acked once, got %v", rdb.acked)
	}
}

func TestPollOnceHandlesReadAndReplayErrors(t *testing.T) {
	for name, setup := range map[string]func(*fakeRedis){
		"claim-nil":   func(rdb *fakeRedis) { rdb.claimErr = redis.Nil },
		"read-nil":    func(rdb *fakeRedis) { rdb.readErr = redis.Nil },
		"read-error":  func(rdb *fakeRedis) { rdb.readErr = errors.New("read failed") },
		"claim-error": func(rdb *fakeRedis) { rdb.claimErr = errors.New("claim failed") },
		"ack-error": func(rdb *fakeRedis) {
			rdb.messages = []redis.XMessage{{ID: "1-3", Values: map[string]any{"session_id": "sid-ack"}}}
			rdb.ackErr = errors.New("ack failed")
		},
		"set-error": func(rdb *fakeRedis) {
			rdb.messages = []redis.XMessage{{ID: "1-4", Values: map[string]any{"session_id": "sid-set"}}}
			rdb.setErr = errors.New("set failed")
		},
	} {
		t.Run(name, func(t *testing.T) {
			rdb := newFakeRedis()
			setup(rdb)
			store := NewStore(rdb)
			consumer, err := NewConsumer(rdb, store, "resource-1")
			if err != nil {
				t.Fatalf("new consumer: %v", err)
			}

			n, err := consumer.PollOnce(context.Background())
			switch name {
			case "claim-nil", "read-nil":
				if err != nil || n != 0 {
					t.Fatalf("want clean empty poll, n=%d err=%v", n, err)
				}
			default:
				if err == nil {
					t.Fatal("expected poll error")
				}
			}
		})
	}
}

func TestReplayPendingContinuesAcrossClaimPages(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)
	rdb.pendingPages = []pendingPage{
		{messages: []redis.XMessage{{ID: "0-1", Values: map[string]any{"session_id": "sid-a"}}}, next: "0-2"},
		{messages: []redis.XMessage{{ID: "0-2", Values: map[string]any{"session_id": "sid-b"}}}, next: "0-0"},
	}
	consumer, err := NewConsumer(rdb, store, "resource-1")
	if err != nil {
		t.Fatalf("new consumer: %v", err)
	}

	n, err := consumer.PollOnce(context.Background())
	if err != nil {
		t.Fatalf("poll once: %v", err)
	}

	if n != 2 || !store.IsRevoked("sid-a") || !store.IsRevoked("sid-b") {
		t.Fatalf("pending pages not fully replayed, n=%d values=%#v", n, rdb.values)
	}
}

type fakeRedis struct {
	values       map[string]string
	ttls         map[string]time.Duration
	getErr       error
	setErr       error
	ackErr       error
	groupErr     error
	readErr      error
	claimErr     error
	pending      []redis.XMessage
	pendingPages []pendingPage
	messages     []redis.XMessage
	acked        []string
}

type pendingPage struct {
	messages []redis.XMessage
	next     string
}

func newFakeRedis() *fakeRedis {
	return &fakeRedis{values: map[string]string{}, ttls: map[string]time.Duration{}}
}

func (f *fakeRedis) Get(_ context.Context, key string) *redis.StringCmd {
	if f.getErr != nil {
		return redis.NewStringResult("", f.getErr)
	}
	value, ok := f.values[key]
	if !ok {
		return redis.NewStringResult("", redis.Nil)
	}
	return redis.NewStringResult(value, nil)
}

func (f *fakeRedis) Set(_ context.Context, key string, value any, ttl time.Duration) *redis.StatusCmd {
	if f.setErr != nil {
		return redis.NewStatusResult("", f.setErr)
	}
	f.values[key] = value.(string)
	f.ttls[key] = ttl
	return redis.NewStatusResult("OK", nil)
}

func (f *fakeRedis) XAck(_ context.Context, _ string, _ string, ids ...string) *redis.IntCmd {
	if f.ackErr != nil {
		return redis.NewIntResult(0, f.ackErr)
	}
	f.acked = append(f.acked, ids...)
	return redis.NewIntResult(int64(len(ids)), nil)
}

func (f *fakeRedis) XGroupCreateMkStream(_ context.Context, _ string, _ string, _ string) *redis.StatusCmd {
	if f.groupErr != nil {
		return redis.NewStatusResult("", f.groupErr)
	}
	return redis.NewStatusResult("OK", nil)
}

func (f *fakeRedis) XReadGroup(_ context.Context, _ *redis.XReadGroupArgs) *redis.XStreamSliceCmd {
	if f.readErr != nil {
		return redis.NewXStreamSliceCmdResult(nil, f.readErr)
	}
	return redis.NewXStreamSliceCmdResult([]redis.XStream{{Stream: RevocationStream, Messages: f.messages}}, nil)
}

func (f *fakeRedis) XAutoClaim(ctx context.Context, _ *redis.XAutoClaimArgs) *redis.XAutoClaimCmd {
	if f.claimErr != nil {
		cmd := redis.NewXAutoClaimCmd(ctx)
		cmd.SetErr(f.claimErr)
		return cmd
	}
	cmd := redis.NewXAutoClaimCmd(ctx)
	if len(f.pendingPages) > 0 {
		page := f.pendingPages[0]
		f.pendingPages = f.pendingPages[1:]
		cmd.SetVal(page.messages, page.next)
		return cmd
	}
	cmd.SetVal(f.pending, "0-0")
	f.pending = nil
	return cmd
}
