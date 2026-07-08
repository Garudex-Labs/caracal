// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Stream consumer loop tests: startup, message dispatch, and failure tracking.

package internal

import (
	"context"
	"crypto/elliptic"
	"errors"
	"sync"
	"testing"

	"github.com/redis/go-redis/v9"
)

// batchSTSRedis serves one scripted stream batch, then cancels the consumer context.
type batchSTSRedis struct {
	fakeSTSRedis
	mu             sync.Mutex
	msgs           []redis.XMessage
	reads          int
	cancel         context.CancelFunc
	ensureFailures int
}

func (b *batchSTSRedis) XReadGroup(_ context.Context, _, _, _ string, _ int64) ([]redis.XMessage, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.reads++
	if b.reads == 1 {
		return b.msgs, nil
	}
	b.cancel()
	return nil, context.Canceled
}

func (b *batchSTSRedis) EnsureGroup(ctx context.Context, stream, group string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ensureFailures > 0 {
		b.ensureFailures--
		return errors.New("redis down")
	}
	return b.fakeSTSRedis.EnsureGroup(ctx, stream, group)
}

func (b *batchSTSRedis) ackCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.acked)
}

// revocationRecorderDB records revoked sessions on top of the shared stub.
type revocationRecorderDB struct {
	stubDB
	mu      sync.Mutex
	revoked []string
}

func (d *revocationRecorderDB) RevokeSession(_ context.Context, zoneID, sid, reason string) error {
	d.mu.Lock()
	d.revoked = append(d.revoked, zoneID+"|"+sid+"|"+reason)
	d.mu.Unlock()
	return nil
}

func TestStartConsumersRetriesGroupCreationThenSignalsReady(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := &batchSTSRedis{fakeSTSRedis: fakeSTSRedis{verify: true}, cancel: cancel, ensureFailures: 1}
	server := testSTSServer(t)
	server.redis = fake

	server.startConsumers(ctx)

	select {
	case <-server.consumersReady:
	default:
		t.Fatal("startConsumers must signal readiness once groups exist")
	}
	fake.mu.Lock()
	ensured := len(fake.ensureCalls)
	fake.mu.Unlock()
	if ensured != 3 {
		t.Fatalf("consumer groups ensured = %d, want 3", ensured)
	}
}

func TestConsumeRevocationsAppliesAndAcksMessages(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := &batchSTSRedis{
		fakeSTSRedis: fakeSTSRedis{verify: true},
		cancel:       cancel,
		msgs: []redis.XMessage{{ID: "1-1", Values: map[string]any{
			"zone_id": "zone-1", "session_id": "sid-1", "reason": "operator_revoked",
		}}},
	}
	db := &revocationRecorderDB{}
	server := testSTSServer(t)
	server.db = db
	server.redis = fake

	server.consumeRevocations(ctx, "test-consumer")

	db.mu.Lock()
	revoked := append([]string(nil), db.revoked...)
	db.mu.Unlock()
	if len(revoked) != 1 || revoked[0] != "zone-1|sid-1|operator_revoked" {
		t.Fatalf("revocations applied = %v", revoked)
	}
	if fake.ackCount() != 1 {
		t.Fatalf("acks = %d, want 1", fake.ackCount())
	}
}

func TestConsumePolicyInvalidationsTracksHandlerFailures(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := &batchSTSRedis{
		fakeSTSRedis: fakeSTSRedis{verify: true},
		cancel:       cancel,
		msgs:         []redis.XMessage{{ID: "1-1", Values: map[string]any{"zone_id": "zone-1"}}},
	}
	server := testSTSServer(t)
	server.redis = fake

	server.consumePolicyInvalidations(ctx, "test-consumer")

	fake.mu.Lock()
	failures := fake.failures
	acks := len(fake.acked)
	fake.mu.Unlock()
	if failures != 1 || acks != 0 {
		t.Fatalf("failed reload must be tracked without ack: failures=%d acks=%d", failures, acks)
	}
}

func TestConsumeKeyInvalidationsFlushesSigningKeyCache(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fake := &batchSTSRedis{
		fakeSTSRedis: fakeSTSRedis{verify: true},
		cancel:       cancel,
		msgs:         []redis.XMessage{{ID: "1-1", Values: map[string]any{"zone_id": "zone-1"}}},
	}
	zek := signingZEK()
	db := &stubDB{secrets: []SecretRow{sealedSecret(t, zek, "kid-active", []byte(ecKeyPEM(t, elliptic.P256())))}}
	server := testSTSServer(t)
	server.redis = fake
	server.keys = newKeyCache(db, testKeyring(zek))
	if _, _, err := server.keys.getKeyAndKid(context.Background(), "zone-1"); err != nil {
		t.Fatal(err)
	}

	server.consumeKeyInvalidations(ctx, "test-consumer")

	server.keys.mu.RLock()
	cached := len(server.keys.entries)
	server.keys.mu.RUnlock()
	if cached != 0 {
		t.Fatalf("key invalidation must flush the zone cache, entries=%d", cached)
	}
	if fake.ackCount() != 1 {
		t.Fatalf("acks = %d, want 1", fake.ackCount())
	}
}

func TestProcessMessageDropsUnsignedMessages(t *testing.T) {
	fake := &batchSTSRedis{fakeSTSRedis: fakeSTSRedis{verify: false}}
	server := testSTSServer(t)
	server.redis = fake

	handled := false
	server.processMessage(context.Background(), streamRevoke, groupRevoke,
		streamMessage{ID: "1-1", Values: map[string]any{"zone_id": "zone-1"}},
		func(context.Context, streamMessage) error {
			handled = true
			return nil
		})
	if handled {
		t.Fatal("unsigned messages must never reach the handler")
	}
	if fake.ackCount() != 1 {
		t.Fatal("unsigned messages must still be acked so they do not replay forever")
	}
}

func TestTrackFailureDeadLettersAfterMaxAttempts(t *testing.T) {
	fake := &batchSTSRedis{fakeSTSRedis: fakeSTSRedis{verify: true, failures: maxFailures - 1}}
	server := testSTSServer(t)
	server.redis = fake

	server.trackFailure(context.Background(), streamRevoke, groupRevoke,
		streamMessage{ID: "1-1", Values: map[string]any{"zone_id": "zone-1"}}, errors.New("boom"))

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.dead) != 1 || len(fake.acked) != 1 || len(fake.deleted) != 1 {
		t.Fatalf("exhausted message must be dead-lettered, acked, and cleared: dead=%d acked=%d deleted=%d",
			len(fake.dead), len(fake.acked), len(fake.deleted))
	}
}

func TestUniqueConsumerIDCarriesPrefix(t *testing.T) {
	id := uniqueConsumerID("sts")
	if id == "" || id[:4] != "sts-" {
		t.Fatalf("consumer id = %q", id)
	}
}
