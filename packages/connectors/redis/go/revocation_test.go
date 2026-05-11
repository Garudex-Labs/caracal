// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis revocation connector tests for key lookup and stream consumption.

package revocationredis

import (
	"context"
	"errors"
	"testing"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/core/crypto"
	"github.com/redis/go-redis/v9"
)

func TestStoreChecksAndRecordsRevokedSessions(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)

	if store.IsRevoked("sid-1") {
		t.Fatal("fresh session should not be revoked")
	}
	store.MarkRevoked("sid-1", time.Hour)
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

func TestConsumerMarksSignedStreamMessages(t *testing.T) {
	rdb := newFakeRedis()
	store := NewStore(rdb)
	key := []byte("0123456789abcdef0123456789abcdef")
	values := map[string]any{"zone_id": "zone1", "session_id": "sid-1", "reason": "grant_revoked"}
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
	if len(rdb.acked) != 1 || rdb.acked[0] != "1-0" {
		t.Fatalf("message should be acked once, got %v", rdb.acked)
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

type fakeRedis struct {
	values   map[string]string
	getErr   error
	messages []redis.XMessage
	acked    []string
}

func newFakeRedis() *fakeRedis {
	return &fakeRedis{values: map[string]string{}}
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

func (f *fakeRedis) Set(_ context.Context, key string, value any, _ time.Duration) *redis.StatusCmd {
	f.values[key] = value.(string)
	return redis.NewStatusResult("OK", nil)
}

func (f *fakeRedis) XAck(_ context.Context, _ string, _ string, ids ...string) *redis.IntCmd {
	f.acked = append(f.acked, ids...)
	return redis.NewIntResult(int64(len(ids)), nil)
}

func (f *fakeRedis) XGroupCreateMkStream(_ context.Context, _ string, _ string, _ string) *redis.StatusCmd {
	return redis.NewStatusResult("OK", nil)
}

func (f *fakeRedis) XReadGroup(_ context.Context, _ *redis.XReadGroupArgs) *redis.XStreamSliceCmd {
	return redis.NewXStreamSliceCmdResult([]redis.XStream{{Stream: RevocationStream, Messages: f.messages}}, nil)
}
