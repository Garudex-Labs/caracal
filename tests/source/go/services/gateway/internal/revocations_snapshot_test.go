// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Revocation store snapshot, failure-tracking, and claim-recovery tests.

package internal

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

type incrErrRedis struct {
	fakeRevocationRedis
}

func TestApplyRevocationSnapshotPreservesConcurrentStreamMarks(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	generation := store.streamGeneration.Load()
	store.markAuthorityRecord("stream-authority")
	store.markGovernedSession("stream-session")
	store.markDelegation("stream-edge")

	applyRevocationSnapshot(store, nil, nil, nil, generation)

	if !store.IsRevoked("stream-authority") || !store.IsSessionRevoked("stream-session") || !store.IsDelegationRevoked("stream-edge") {
		t.Fatal("snapshot reload must preserve newer stream revocations")
	}
}

func (r *incrErrRedis) IncrWithExpiry(context.Context, string, time.Duration) (int64, error) {
	return 0, errors.New("incr down")
}

type deadLetterErrRedis struct {
	fakeRevocationRedis
}

func (r *deadLetterErrRedis) SignedXAdd(context.Context, string, map[string]any) error {
	return errors.New("xadd down")
}

type ackErrRedis struct {
	fakeRevocationRedis
}

func (r *ackErrRedis) XAck(context.Context, string, string, string) error {
	return errors.New("ack down")
}

type claimErrRedis struct {
	fakeRevocationRedis
}

func (r *claimErrRedis) XAutoClaim(context.Context, string, string, string, string, time.Duration, int64) ([]redis.XMessage, string, error) {
	return nil, "", errors.New("claim down")
}

func TestSnapshotAgeAndSizeHandleNilAndFutureTimestamps(t *testing.T) {
	var store *revocationStore
	if _, ok := store.SnapshotAge(time.Now()); ok {
		t.Fatal("nil store must report no snapshot age")
	}
	if store.Size() != 0 {
		t.Fatal("nil store must report size 0")
	}

	store = newRevocationStore(zerolog.Nop())
	now := time.Now()
	if _, ok := store.SnapshotAge(now); ok {
		t.Fatal("unseeded store must report no snapshot age")
	}
	store.markSnapshotFresh(now.Add(time.Hour))
	if _, ok := store.SnapshotAge(now); ok {
		t.Fatal("future snapshot must report no age")
	}
}

func TestPruneDropsExpiredAgentAndDelegationEntries(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	store.markGovernedSession("agent1")
	store.markDelegation("edge1")
	store.mu.Lock()
	store.governedSessions["agent1"] = time.Now().Add(-time.Second)
	store.edges["edge1"] = time.Now().Add(-time.Second)
	store.mu.Unlock()

	store.prune()

	if store.Size() != 0 {
		t.Fatalf("size after prune = %d", store.Size())
	}
}

func TestStreamMessageAgeParsesStreamIDs(t *testing.T) {
	now := time.Now()
	if _, ok := streamMessageAge("nodash", now); ok {
		t.Fatal("id without dash must not parse")
	}
	if _, ok := streamMessageAge("-0", now); ok {
		t.Fatal("empty millis must not parse")
	}
	if _, ok := streamMessageAge("xx-0", now); ok {
		t.Fatal("non-numeric millis must not parse")
	}
	if age, ok := streamMessageAge(fmt.Sprintf("%d-0", now.Add(time.Minute).UnixMilli()), now); !ok || age != 0 {
		t.Fatalf("future id age = %v ok=%v", age, ok)
	}
	if age, ok := streamMessageAge(fmt.Sprintf("%d-0", now.Add(-time.Minute).UnixMilli()), now); !ok || age < 59*time.Second {
		t.Fatalf("past id age = %v ok=%v", age, ok)
	}
}

func TestTrackRevocationFailureToleratesRedisErrors(t *testing.T) {
	msg := redisMessage("9-0", map[string]any{"bad": "message"})
	metrics := &GatewayMetrics{}

	incrBroken := &incrErrRedis{}
	trackRevocationFailure(context.Background(), incrBroken, groupRevoke, msg, errors.New("bad message"), metrics, zerolog.Nop())
	if len(incrBroken.dead) != 0 {
		t.Fatal("failed counter must not dead-letter")
	}

	dlqBroken := &deadLetterErrRedis{}
	for range maxFailures {
		trackRevocationFailure(context.Background(), dlqBroken, groupRevoke, msg, errors.New("bad message"), metrics, zerolog.Nop())
	}
	if len(dlqBroken.acked) != 0 || len(dlqBroken.deleted) != 0 {
		t.Fatal("failed dead-letter must not ack or clear the counter")
	}

	ackBroken := &ackErrRedis{}
	for range maxFailures {
		trackRevocationFailure(context.Background(), ackBroken, groupRevoke, msg, errors.New("bad message"), metrics, zerolog.Nop())
	}
	if len(ackBroken.deleted) != 0 {
		t.Fatal("failed ack must not clear the counter")
	}
	if metrics.Snapshot().RevocationDeadLetters != 0 {
		t.Fatalf("dead-letter metric = %d", metrics.Snapshot().RevocationDeadLetters)
	}
}

func TestJWTClaimHelpersRejectMalformedPayloads(t *testing.T) {
	badBase64 := "h.!!!.s"
	badJSON := "h." + base64.RawURLEncoding.EncodeToString([]byte("{")) + ".s"
	for name, fn := range map[string]func(string) string{
		"sid":        jwtAuthorityRecordID,
		"agent":      jwtSessionID,
		"delegation": jwtDelegationEdgeID,
		"root":       jwtRootAuthorityRecordID,
	} {
		if got := fn(badBase64); got != "" {
			t.Fatalf("%s: bad base64 = %q", name, got)
		}
		if got := fn(badJSON); got != "" {
			t.Fatalf("%s: bad json = %q", name, got)
		}
	}
	if got := jwtSessionID("notajwt"); got != "" {
		t.Fatalf("agent malformed = %q", got)
	}
	if got := jwtDelegationEdgeID("notajwt"); got != "" {
		t.Fatalf("delegation malformed = %q", got)
	}
	if got := jwtRootAuthorityRecordID("notajwt"); got != "" {
		t.Fatalf("root malformed = %q", got)
	}
}

func TestReplayPendingRevocationsStopsOnClaimError(t *testing.T) {
	metrics := &GatewayMetrics{}
	replayPendingRevocations(context.Background(), &claimErrRedis{}, newRevocationStore(zerolog.Nop()), groupRevoke, "consumer-1", metrics, zerolog.Nop())
	if metrics.Snapshot().RevocationPendingReplayed != 0 {
		t.Fatal("claim failure must not count replayed messages")
	}
}

func TestReloadRevocationSnapshotFailsWithoutStoreOrDatabase(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://caracal@127.0.0.1:1/caracal")
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	if err := reloadRevocationSnapshot(context.Background(), pool, nil); err == nil {
		t.Fatal("nil store must fail the snapshot reload")
	}
	if err := reloadRevocationSnapshot(context.Background(), pool, newRevocationStore(zerolog.Nop())); err == nil {
		t.Fatal("unreachable postgres must fail the snapshot reload")
	}
}

func TestStartRevocationSnapshotPollingStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	startRevocationSnapshotPolling(ctx, nil, newRevocationStore(zerolog.Nop()), &GatewayMetrics{}, zerolog.Nop())
	time.Sleep(20 * time.Millisecond)
}

type readErrRedis struct {
	fakeRevocationRedis
	cancel context.CancelFunc
	calls  int
}

func (r *readErrRedis) XReadGroup(context.Context, string, string, string, int64) ([]redis.XMessage, error) {
	r.calls++
	if r.calls > 1 {
		r.cancel()
	}
	return nil, errors.New("read down")
}

func TestRunRevocationLoopRetriesAfterReadError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rdb := &readErrRedis{cancel: cancel}

	runRevocationLoop(ctx, rdb, newRevocationStore(zerolog.Nop()), groupRevoke, "consumer-1", nil, zerolog.Nop())

	if rdb.calls < 2 {
		t.Fatalf("read calls = %d, want retry after failure", rdb.calls)
	}
}
