// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS Redis-backed consumer, nonce, and audit replay path tests.

package internal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

type fakeSTSRedis struct {
	verify      bool
	pingErr     error
	setNX       bool
	setNXErr    error
	incrErr     error
	xaddErr     error
	ensureCalls []string
	acked       []string
	dead        []map[string]any
	deleted     []string
	xadds       []map[string]any
	claims      [][]redis.XMessage
	claimIndex  int
	failures    int64
}

func (f *fakeSTSRedis) Ping(context.Context) error { return f.pingErr }
func (f *fakeSTSRedis) EvictionPolicy(context.Context) (string, error) {
	return "noeviction", nil
}
func (f *fakeSTSRedis) SetNXTTL(context.Context, string, string, time.Duration) (bool, error) {
	return f.setNX, f.setNXErr
}
func (f *fakeSTSRedis) SetTTL(context.Context, string, any, time.Duration) error { return nil }
func (f *fakeSTSRedis) Get(context.Context, string) (string, error)              { return "", redis.Nil }
func (f *fakeSTSRedis) Del(_ context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return nil
}
func (f *fakeSTSRedis) DelIfValue(context.Context, string, string) error { return nil }
func (f *fakeSTSRedis) ExpireIfValue(context.Context, string, string, time.Duration) (bool, error) {
	return true, nil
}
func (f *fakeSTSRedis) Exists(context.Context, string) (bool, error) { return false, nil }
func (f *fakeSTSRedis) IncrWithExpiry(context.Context, string, time.Duration) (int64, error) {
	if f.incrErr != nil {
		return 0, f.incrErr
	}
	f.failures++
	return f.failures, nil
}
func (f *fakeSTSRedis) EnsureGroup(_ context.Context, stream, group string) error {
	f.ensureCalls = append(f.ensureCalls, stream+":"+group)
	return nil
}
func (f *fakeSTSRedis) XReadGroup(ctx context.Context, _, _, _ string, _ int64) ([]redis.XMessage, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (f *fakeSTSRedis) XAutoClaim(_ context.Context, _, _, _, _ string, _ time.Duration, _ int64) ([]redis.XMessage, string, error) {
	if f.claimIndex >= len(f.claims) {
		return nil, "0-0", nil
	}
	msgs := f.claims[f.claimIndex]
	f.claimIndex++
	return msgs, "0-0", nil
}
func (f *fakeSTSRedis) VerifyStream(string, map[string]any) bool { return f.verify }
func (f *fakeSTSRedis) XAck(_ context.Context, _, _ string, id string) error {
	f.acked = append(f.acked, id)
	return nil
}
func (f *fakeSTSRedis) SignedXAdd(_ context.Context, _ string, values map[string]any) error {
	f.dead = append(f.dead, values)
	return nil
}
func (f *fakeSTSRedis) XAdd(_ context.Context, _ string, values map[string]any) error {
	if f.xaddErr != nil {
		return f.xaddErr
	}
	f.xadds = append(f.xadds, values)
	return nil
}

func TestConsumeGatewayNonceRejectsInvalidInputs(t *testing.T) {
	s := &Server{}
	if err := s.consumeGatewayNonce(context.Background(), ""); err == nil {
		t.Fatal("empty request id must fail")
	}
	if err := s.consumeGatewayNonce(context.Background(), "req-1"); err == nil {
		t.Fatal("missing redis must fail closed")
	}
}

func TestConsumeGatewayNonceDetectsReplayAndStoreErrors(t *testing.T) {
	ctx := context.Background()
	s := &Server{redis: &fakeSTSRedis{setNX: true}}
	if err := s.consumeGatewayNonce(ctx, "req-1"); err != nil {
		t.Fatalf("first nonce should pass: %v", err)
	}

	s.redis = &fakeSTSRedis{setNX: false}
	if err := s.consumeGatewayNonce(ctx, "req-1"); err == nil {
		t.Fatal("replayed nonce must fail")
	}

	want := errors.New("redis down")
	s.redis = &fakeSTSRedis{setNXErr: want}
	if err := s.consumeGatewayNonce(ctx, "req-2"); !errors.Is(err, want) {
		t.Fatalf("want redis error, got %v", err)
	}
}

func TestProcessMessageAcksInvalidSignatureWithoutSideEffect(t *testing.T) {
	redis := &fakeSTSRedis{verify: false}
	s := &Server{redis: redis, log: zerolog.Nop()}
	called := false

	s.processMessage(context.Background(), streamRevoke, groupRevoke, streamMessage{ID: "1-0", Values: map[string]any{"zone_id": "z1"}}, func(context.Context, streamMessage) error {
		called = true
		return nil
	})

	if called {
		t.Fatal("invalid signature must not run side effect")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "1-0" {
		t.Fatalf("invalid message should be acked once, got %v", redis.acked)
	}
}

func TestProcessMessageAcksSuccessfulSideEffect(t *testing.T) {
	redis := &fakeSTSRedis{verify: true}
	s := &Server{redis: redis, log: zerolog.Nop()}
	called := false

	s.processMessage(context.Background(), streamPolicy, groupPolicy, streamMessage{ID: "2-0", Values: map[string]any{"zone_id": "z1"}}, func(context.Context, streamMessage) error {
		called = true
		return nil
	})

	if !called {
		t.Fatal("valid message should run side effect")
	}
	if len(redis.acked) != 1 || redis.acked[0] != "2-0" {
		t.Fatalf("successful message should be acked once, got %v", redis.acked)
	}
}

func TestProcessMessageDeadLettersAfterRepeatedFailures(t *testing.T) {
	redis := &fakeSTSRedis{verify: true}
	s := &Server{redis: redis, log: zerolog.Nop()}
	msg := streamMessage{ID: "3-0", Values: map[string]any{"zone_id": "z1"}}
	want := errors.New("side effect failed")

	for range maxFailures {
		s.processMessage(context.Background(), streamKeys, groupKeys, msg, func(context.Context, streamMessage) error {
			return want
		})
	}

	if len(redis.dead) != 1 {
		t.Fatalf("want one dead-letter message, got %d", len(redis.dead))
	}
	if redis.dead[0]["error"] != want.Error() {
		t.Fatalf("dead-letter error = %#v", redis.dead[0]["error"])
	}
	if len(redis.acked) != 1 || redis.acked[0] != "3-0" {
		t.Fatalf("dead-lettered message should be acked once, got %v", redis.acked)
	}
	if len(redis.deleted) != 1 {
		t.Fatalf("failure counter should be deleted, got %v", redis.deleted)
	}
}

func TestReplayPendingProcessesClaimedMessages(t *testing.T) {
	redis := &fakeSTSRedis{
		verify: true,
		claims: [][]redis.XMessage{
			{{ID: "1-0", Values: map[string]any{"zone_id": "z1"}}, {ID: "2-0", Values: map[string]any{"zone_id": "z2"}}},
		},
	}
	s := &Server{redis: redis, log: zerolog.Nop()}
	seen := 0

	s.replayPending(context.Background(), streamPolicy, groupPolicy, "consumer-1", func(context.Context, streamMessage) error {
		seen++
		return nil
	})

	if seen != 2 {
		t.Fatalf("want 2 replayed messages, got %d", seen)
	}
	if len(redis.acked) != 2 {
		t.Fatalf("want two acknowledgements, got %v", redis.acked)
	}
}

func TestStartConsumersEnsuresGroupsBeforeReady(t *testing.T) {
	redis := &fakeSTSRedis{verify: true}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{redis: redis, consumersReady: make(chan struct{}), log: zerolog.Nop()}

	s.startConsumers(ctx)
	select {
	case <-s.consumersReady:
	case <-time.After(time.Second):
		t.Fatal("consumersReady was not closed")
	}
	cancel()

	want := []string{streamRevoke + ":" + groupRevoke, streamPolicy + ":" + groupPolicy, streamKeys + ":" + groupKeys}
	if len(redis.ensureCalls) != len(want) {
		t.Fatalf("ensure calls = %v", redis.ensureCalls)
	}
	for i := range want {
		if redis.ensureCalls[i] != want[i] {
			t.Fatalf("ensure call %d = %q want %q", i, redis.ensureCalls[i], want[i])
		}
	}
}

func TestAuditBufferReplayFileSignsAndUpdatesMetrics(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pending.ndjson")
	if err := os.WriteFile(path, []byte("{bad json}\n{\"id\":\"ev-1\",\"zone_id\":\"z1\",\"decision\":\"allow\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	redis := &fakeSTSRedis{}
	metrics := &STSMetrics{}
	metrics.AuditReplayPending.Store(3)
	buf := &AuditBuffer{
		redis:        redis,
		log:          zerolog.Nop(),
		auditHMACKey: []byte("12345678901234567890123456789012"),
		replayDir:    dir,
		metrics:      metrics,
	}

	if err := buf.replayFile(context.Background(), path); err != nil {
		t.Fatalf("replayFile: %v", err)
	}
	if len(redis.xadds) != 1 {
		t.Fatalf("want one replayed event, got %d", len(redis.xadds))
	}
	if redis.xadds[0]["sig"] == "" {
		t.Fatalf("replayed event should be signed: %#v", redis.xadds[0])
	}
	if metrics.AuditReplayReplayed.Load() != 1 || metrics.AuditReplayPending.Load() != 2 {
		t.Fatalf("unexpected replay metrics: replayed=%d pending=%d", metrics.AuditReplayReplayed.Load(), metrics.AuditReplayPending.Load())
	}
}

func TestAuditBufferReplayPendingRemovesOnlyDrainedFiles(t *testing.T) {
	dir := t.TempDir()
	keep := filepath.Join(dir, "keep.ndjson")
	remove := filepath.Join(dir, "remove.ndjson")
	if err := os.WriteFile(keep, []byte("{\"id\":\"ev-1\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(remove, []byte("{\"id\":\"ev-2\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	buf := &AuditBuffer{redis: &fakeSTSRedis{xaddErr: errors.New("sink down")}, log: zerolog.Nop(), replayDir: dir}
	buf.replayPending(context.Background())
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("failed replay file should remain: %v", err)
	}

	buf.redis = &fakeSTSRedis{}
	buf.replayPending(context.Background())
	if _, err := os.Stat(remove); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("drained replay file should be removed, got %v", err)
	}
}

func TestHandleKeyInvalidationRequiresZoneAndClearsCache(t *testing.T) {
	keys := newKeyCache(&stubDB{}, testKeyring([]byte("12345678901234567890123456789012")))
	keys.entries["zone-1"] = &zoneCacheEntry{expiresAt: time.Now().Add(time.Hour)}
	keys.pubKeysCache["zone-1"] = &publicKeysCacheEntry{expiresAt: time.Now().Add(time.Hour)}
	s := &Server{keys: keys}

	if err := s.handleKeyInvalidation(context.Background(), streamMessage{Values: map[string]any{}}); err == nil {
		t.Fatal("missing zone id must fail")
	}
	if err := s.handleKeyInvalidation(context.Background(), streamMessage{Values: map[string]any{"zone_id": "zone-1"}}); err != nil {
		t.Fatalf("key invalidation: %v", err)
	}
	if _, ok := keys.entries["zone-1"]; ok {
		t.Fatal("private key cache entry should be invalidated")
	}
	if _, ok := keys.pubKeysCache["zone-1"]; ok {
		t.Fatal("public key cache entry should be invalidated")
	}
}

func TestCheckRateLimitAllowsWithinLimitAndFailsClosed(t *testing.T) {
	if err := (&Server{}).checkRateLimit(context.Background(), "z", "r", "a"); err == nil {
		t.Fatal("missing redis must fail closed")
	}
	if err := (&Server{redis: &fakeSTSRedis{}}).checkRateLimit(context.Background(), "z", "r", "a"); err != nil {
		t.Fatalf("first request should pass: %v", err)
	}
	if err := (&Server{redis: &fakeSTSRedis{failures: defaultMintRateLimit}}).checkRateLimit(context.Background(), "z", "r", "a"); err == nil {
		t.Fatal("counter above limit must fail")
	}
	if err := (&Server{redis: &fakeSTSRedis{incrErr: errors.New("redis down")}}).checkRateLimit(context.Background(), "z", "r", "a"); err == nil {
		t.Fatal("redis error must fail closed")
	}
}

func TestRecordIssuedJTIHandlesSuccessCollisionAndStoreErrors(t *testing.T) {
	ctx := context.Background()
	if err := (&Server{}).recordIssuedJTI(ctx, "", "app", "zone", "req", time.Minute); err != nil {
		t.Fatalf("empty jti should be ignored: %v", err)
	}
	if err := (&Server{redis: &fakeSTSRedis{setNX: true}, log: zerolog.Nop()}).recordIssuedJTI(ctx, "jti-1", "app", "zone", "req", time.Minute); err != nil {
		t.Fatalf("new jti should pass: %v", err)
	}
	auditBuf := &AuditBuffer{ch: make(chan AuditEvent, 1), log: zerolog.Nop(), replayDir: t.TempDir()}
	err := (&Server{redis: &fakeSTSRedis{setNX: false}, auditBuffer: auditBuf, log: zerolog.Nop()}).recordIssuedJTI(ctx, "jti-1", "app", "zone", "req", time.Minute)
	if err == nil {
		t.Fatal("jti collision must fail")
	}
	if len(auditBuf.ch) != 1 {
		t.Fatalf("collision should emit one audit event, got %d", len(auditBuf.ch))
	}
	want := errors.New("setnx failed")
	err = (&Server{redis: &fakeSTSRedis{setNXErr: want}, log: zerolog.Nop()}).recordIssuedJTI(ctx, "jti-2", "app", "zone", "req", time.Minute)
	if !errors.Is(err, want) {
		t.Fatalf("want redis error, got %v", err)
	}
}

func TestAuditBufferRefreshReplayStatsHandlesNilAndFiles(t *testing.T) {
	(*AuditBuffer)(nil).RefreshReplayStats(time.Now())
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pending.ndjson"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	metrics := &STSMetrics{}
	(&AuditBuffer{replayDir: dir, metrics: metrics}).RefreshReplayStats(time.Now())
	if metrics.AuditReplayFiles.Load() != 1 || metrics.AuditReplayBytes.Load() == 0 {
		t.Fatalf("unexpected replay stats: files=%d bytes=%d", metrics.AuditReplayFiles.Load(), metrics.AuditReplayBytes.Load())
	}
}

func TestOPAEngineIntervalAndBundleInfo(t *testing.T) {
	e := newOPAEngine(nil)
	original := e.pollInterval
	e.SetPollInterval(0)
	if e.pollInterval != original {
		t.Fatal("non-positive poll interval should be ignored")
	}
	e.SetPollInterval(time.Second)
	if e.pollInterval != time.Second {
		t.Fatalf("poll interval = %v", e.pollInterval)
	}
	if info := e.BundleInfo("missing"); info.PolicySetVersionID != "" || info.ManifestSHA != "" || !info.LoadedAt.IsZero() {
		t.Fatalf("missing bundle info should have empty zone fields: %+v", info)
	}
	if info := e.BundleInfo("missing"); info.DecisionContractVersion != DecisionContractVersion || info.DecisionContractSHA == "" {
		t.Fatalf("bundle info must always carry decision contract provenance: %+v", info)
	}
	loadedAt := time.Now()
	e.zones["zone-1"] = &opaZoneState{policySetVersionID: "psv-1", manifestSHA: "sha", loadedAt: loadedAt}
	info := e.BundleInfo("zone-1")
	if info.PolicySetVersionID != "psv-1" || info.ManifestSHA != "sha" || !info.LoadedAt.Equal(loadedAt) {
		t.Fatalf("unexpected bundle info: %+v", info)
	}
}
