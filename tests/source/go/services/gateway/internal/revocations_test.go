// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the gateway's revocation cache and authority-record claim extraction.

package internal

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

func TestRevocationStoreMarkAndExpire(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	if store.IsRevoked("sid1") {
		t.Fatalf("fresh store should not report sid1 revoked")
	}
	store.markAuthorityRecord("sid1")
	if !store.IsRevoked("sid1") {
		t.Fatalf("sid1 should be revoked after mark")
	}
	store.mu.Lock()
	store.authorityRecords["sid1"] = time.Now().Add(-time.Second)
	store.mu.Unlock()
	if store.IsRevoked("sid1") {
		t.Fatalf("expired entry should not report revoked")
	}
	store.prune()
	store.mu.RLock()
	_, present := store.authorityRecords["sid1"]
	store.mu.RUnlock()
	if present {
		t.Fatalf("prune should drop expired entries")
	}
}

func TestRevocationStoreEmptySessionNotRevoked(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	if store.IsRevoked("") {
		t.Fatalf("empty authority-record id must report not revoked")
	}
}

func TestProcessRevocationMessageRequiresValidSignature(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: false}

	processRevocationMessage(context.Background(), redis, store, redisMessage("1-0", map[string]any{"session_id": "sid1"}), nil, zerolog.New(io.Discard))

	if store.IsRevoked("sid1") {
		t.Fatalf("invalid stream signature must not mark session revoked")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-0" {
		t.Fatalf("invalid stream message should be acked once, got %v", redis.acked)
	}
}

func TestProcessRevocationMessageMarksSignedSession(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}

	processRevocationMessage(context.Background(), redis, store, redisMessage("1-1", map[string]any{"session_id": "sid1"}), nil, zerolog.New(io.Discard))

	if !store.IsRevoked("sid1") {
		t.Fatalf("valid revocation message should mark session revoked")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-1" {
		t.Fatalf("valid stream message should be acked once, got %v", redis.acked)
	}
}

func TestProcessRevocationMessageUpdatesMetrics(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}
	metrics := &GatewayMetrics{}
	id := time.Now().Add(-3 * time.Second).Format("150405")
	msgID := fmt.Sprintf("%d-0", time.Now().Add(-3*time.Second).UnixMilli())

	processRevocationMessage(context.Background(), redis, store, redisMessage(msgID, map[string]any{"session_id": id}), metrics, zerolog.New(io.Discard))

	snap := metrics.Snapshot()
	if snap.RevocationMessages != 1 {
		t.Fatalf("expected one applied revocation, got %d", snap.RevocationMessages)
	}
	if snap.RevocationPropagationSeconds == 0 {
		t.Fatal("expected revocation propagation age")
	}
}

func TestProcessRevocationMessageMarksSignedAgent(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}

	processRevocationMessage(context.Background(), redis, store, redisMessage("1-3", map[string]any{"agent_session_id": "agent1"}), nil, zerolog.New(io.Discard))

	if !store.IsSessionRevoked("agent1") {
		t.Fatalf("valid revocation message should mark agent revoked")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-3" {
		t.Fatalf("valid stream message should be acked once, got %v", redis.acked)
	}
}

func TestProcessRevocationMessageMarksSignedDelegation(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}

	processRevocationMessage(context.Background(), redis, store, redisMessage("1-4", map[string]any{"delegation_edge_id": "edge1"}), nil, zerolog.New(io.Discard))

	if !store.IsDelegationRevoked("edge1") {
		t.Fatalf("valid revocation message should mark Delegation revoked")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-4" {
		t.Fatalf("valid stream message should be acked once, got %v", redis.acked)
	}
}

func TestApplyRevocationSnapshotMarksAllAuthorityAnchors(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	applyRevocationSnapshot(store, []string{"sid1"}, []string{"agent1"}, []string{"edge1"})
	if !store.IsRevoked("sid1") {
		t.Fatalf("snapshot should mark Authority record revoked")
	}
	if !store.IsSessionRevoked("agent1") {
		t.Fatalf("snapshot should mark Session revoked")
	}
	if !store.IsDelegationRevoked("edge1") {
		t.Fatalf("snapshot should mark Delegation revoked")
	}
}

func TestApplyRevocationSnapshotRemovesResumedSession(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	applyRevocationSnapshot(store, nil, []string{"agent1"}, nil)
	if !store.IsSessionRevoked("agent1") {
		t.Fatal("suspended Session must be present in the snapshot")
	}
	applyRevocationSnapshot(store, nil, nil, nil)
	if store.IsSessionRevoked("agent1") {
		t.Fatal("resumed Session must be removed by the current-state snapshot")
	}
}

func TestRevocationSnapshotFreshness(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	now := time.Now()
	if store.SnapshotFresh(now) {
		t.Fatal("snapshot must not be fresh before first successful reload")
	}
	store.markSnapshotFresh(now.Add(-snapshotStaleAfter + time.Second))
	if !store.SnapshotFresh(now) {
		t.Fatal("snapshot inside freshness window must be fresh")
	}
	store.markSnapshotFresh(now.Add(-snapshotStaleAfter - time.Second))
	if store.SnapshotFresh(now) {
		t.Fatal("snapshot outside freshness window must be stale")
	}
}

func TestProcessRevocationMessageDeadLettersPoisonMessage(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	redis := &fakeRevocationRedis{verify: true}
	msg := redisMessage("1-2", map[string]any{"zone_id": "zone1"})

	for i := 0; i < maxFailures; i++ {
		processRevocationMessage(context.Background(), redis, store, msg, nil, zerolog.New(io.Discard))
	}

	if len(redis.dead) != 1 {
		t.Fatalf("poison message should be dead-lettered once, got %d", len(redis.dead))
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-2" {
		t.Fatalf("dead-lettered message should be acked once, got %v", redis.acked)
	}
	if len(redis.deleted) != 1 {
		t.Fatalf("failure counter should be deleted after dead-letter, got %v", redis.deleted)
	}
}

func TestJWTAuthorityRecordIDReadsSidClaim(t *testing.T) {
	payload := `{"sid":"sess-123","agent_session_id":"agent-xyz"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtAuthorityRecordID(tok); got != "sess-123" {
		t.Fatalf("want sess-123, got %q", got)
	}
}

func TestJWTAuthorityRecordIDRequiresSidClaim(t *testing.T) {
	payload := `{"agent_session_id":"agent-xyz"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtAuthorityRecordID(tok); got != "" {
		t.Fatalf("want empty sid, got %q", got)
	}
}

func TestJWTSessionIDReadsClaim(t *testing.T) {
	payload := `{"sid":"sess-123","agent_session_id":"agent-xyz"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtSessionID(tok); got != "agent-xyz" {
		t.Fatalf("want agent-xyz, got %q", got)
	}
}

func TestJWTDelegationEdgeIDReadsClaim(t *testing.T) {
	payload := `{"sid":"sess-123","agent_session_id":"agent-xyz","delegation_edge_id":"edge-123"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtDelegationEdgeID(tok); got != "edge-123" {
		t.Fatalf("want edge-123, got %q", got)
	}
}

func TestJWTRootAuthorityRecordIDReadsClaim(t *testing.T) {
	payload := `{"sid":"sess-123","root_sid":"root-123"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtRootAuthorityRecordID(tok); got != "root-123" {
		t.Fatalf("want root-123, got %q", got)
	}
}

func TestJWTAuthorityRecordIDMalformed(t *testing.T) {
	if got := jwtAuthorityRecordID("notajwt"); got != "" {
		t.Fatalf("malformed token should return empty sid, got %q", got)
	}
}

func redisMessage(id string, values map[string]any) redis.XMessage {
	return redis.XMessage{ID: id, Values: values}
}

type fakeRevocationRedis struct {
	verify     bool
	acked      []string
	failures   int64
	dead       []map[string]any
	deleted    []string
	claims     [][]redis.XMessage
	claimIndex int
}

func (f *fakeRevocationRedis) EnsureGroup(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeRevocationRedis) EvictionPolicy(_ context.Context) (string, error) {
	return "noeviction", nil
}

func (f *fakeRevocationRedis) XReadGroup(_ context.Context, _, _, _ string, _ int64) ([]redis.XMessage, error) {
	return nil, nil
}

func (f *fakeRevocationRedis) XAutoClaim(_ context.Context, _, _, _, _ string, _ time.Duration, _ int64) ([]redis.XMessage, string, error) {
	if f.claimIndex < len(f.claims) {
		msgs := f.claims[f.claimIndex]
		f.claimIndex++
		return msgs, "0-0", nil
	}
	return nil, "0-0", nil
}

func (f *fakeRevocationRedis) XAck(_ context.Context, _, _ string, id string) error {
	f.acked = append(f.acked, id)
	return nil
}

func (f *fakeRevocationRedis) VerifyStream(_ string, _ map[string]any) bool {
	return f.verify
}

func (f *fakeRevocationRedis) SignedXAdd(_ context.Context, _ string, values map[string]any) error {
	f.dead = append(f.dead, values)
	return nil
}

func (f *fakeRevocationRedis) IncrWithExpiry(_ context.Context, _ string, _ time.Duration) (int64, error) {
	f.failures++
	return f.failures, nil
}

func (f *fakeRevocationRedis) Del(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return nil
}

type ensureGroupFailRedis struct {
	fakeRevocationRedis
	err error
}

func (e *ensureGroupFailRedis) EnsureGroup(_ context.Context, _, _ string) error {
	return e.err
}

func TestStartRevocationConsumerNilRedisFailsStartup(t *testing.T) {
	if err := startRevocationConsumer(context.Background(), nil, newRevocationStore(zerolog.Nop()), nil, zerolog.Nop()); err == nil {
		t.Fatalf("expected nil redis to fail startup")
	}
}

func TestStartRevocationConsumerEnsureGroupFailureSurfaces(t *testing.T) {
	want := errors.New("ensure boom")
	r := &ensureGroupFailRedis{err: want}
	err := startRevocationConsumer(context.Background(), r, newRevocationStore(zerolog.Nop()), nil, zerolog.Nop())
	if err == nil {
		t.Fatal("expected error from EnsureGroup failure, got nil")
	}
	if !errors.Is(err, want) {
		t.Fatalf("expected wrapped %v, got %v", want, err)
	}
}

func TestStartRevocationConsumerRequiresStore(t *testing.T) {
	err := startRevocationConsumer(context.Background(), &fakeRevocationRedis{}, nil, nil, zerolog.Nop())
	if err == nil {
		t.Fatal("expected missing store to fail startup")
	}
}

func TestReplayPendingRevocationsProcessesClaimedMessages(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	metrics := &GatewayMetrics{}
	redis := &fakeRevocationRedis{
		verify: true,
		claims: [][]redis.XMessage{
			{redisMessage("1-0", map[string]any{"session_id": "sid-1"}), redisMessage("2-0", map[string]any{"agent_session_id": "agent-1"})},
		},
	}

	replayPendingRevocations(context.Background(), redis, store, "consumer-1", metrics, zerolog.Nop())

	if !store.IsRevoked("sid-1") || !store.IsSessionRevoked("agent-1") {
		t.Fatal("claimed revocation messages should update the store")
	}
	if metrics.Snapshot().RevocationPendingReplayed != 2 {
		t.Fatalf("pending replay metric = %d", metrics.Snapshot().RevocationPendingReplayed)
	}
	if len(redis.acked) != 2 {
		t.Fatalf("claimed messages should be acked, got %v", redis.acked)
	}
}

func TestProcessRevocationMessagesAppliesEveryMessage(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	rdb := &fakeRevocationRedis{verify: true}

	processRevocationMessages(context.Background(), rdb, store, []redis.XMessage{
		redisMessage("1-0", map[string]any{"session_id": "sid-1"}),
		redisMessage("2-0", map[string]any{"edge_id": "edge-1"}),
	}, nil, zerolog.Nop())

	if !store.IsRevoked("sid-1") || !store.IsDelegationRevoked("edge-1") {
		t.Fatal("batch processing should apply session and delegation revocations")
	}
}

func TestTrackRevocationFailureIncrementsDeadLetterMetrics(t *testing.T) {
	redis := &fakeRevocationRedis{}
	metrics := &GatewayMetrics{}
	msg := redisMessage("9-0", map[string]any{"bad": "message"})

	for range maxFailures {
		trackRevocationFailure(context.Background(), redis, msg, errors.New("bad message"), metrics, zerolog.Nop())
	}

	if metrics.Snapshot().RevocationDeadLetters != 1 {
		t.Fatalf("dead-letter metric = %d", metrics.Snapshot().RevocationDeadLetters)
	}
}

func TestRevocationBackgroundHelpersStopOnCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runRevocationGC(ctx, newRevocationStore(zerolog.Nop()))
	runRevocationLoop(ctx, &fakeRevocationRedis{}, newRevocationStore(zerolog.Nop()), "consumer-1", nil, zerolog.Nop())
	if hostname() == "" {
		t.Fatal("hostname helper should never return empty")
	}
}

func TestStartRevocationConsumerLaunchesBackgroundLoops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := startRevocationConsumer(ctx, &fakeRevocationRedis{}, newRevocationStore(zerolog.Nop()), nil, zerolog.Nop()); err != nil {
		t.Fatalf("healthy redis must start the consumer, got %v", err)
	}
}

func TestReloadRevocationSnapshotRequiresPostgres(t *testing.T) {
	if err := reloadRevocationSnapshot(context.Background(), nil, newRevocationStore(zerolog.Nop())); err == nil {
		t.Fatal("nil pool must fail the snapshot reload")
	}
}

type revocationBatchRedis struct {
	fakeRevocationRedis
	cancel context.CancelFunc
	msgs   []redis.XMessage
	calls  int
}

func (r *revocationBatchRedis) XReadGroup(_ context.Context, _, _, _ string, _ int64) ([]redis.XMessage, error) {
	r.calls++
	if r.calls == 1 {
		return r.msgs, nil
	}
	r.cancel()
	return nil, context.Canceled
}

func TestRunRevocationLoopAppliesStreamMessages(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := newRevocationStore(zerolog.Nop())
	redis := &revocationBatchRedis{cancel: cancel, msgs: []redis.XMessage{redisMessage("1-0", map[string]any{"session_id": "sid-live"})}}
	redis.verify = true

	runRevocationLoop(ctx, redis, store, "consumer-1", nil, zerolog.Nop())

	if !store.IsRevoked("sid-live") {
		t.Fatal("stream message must revoke the session")
	}
	if len(redis.acked) != 1 {
		t.Fatalf("processed message must be acked, got %v", redis.acked)
	}
}
