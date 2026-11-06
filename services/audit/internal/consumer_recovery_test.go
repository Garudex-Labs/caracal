// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit consumer backoff and JSON sanitizer recovery tests.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestConsumerRunBacksOffWhenGroupCreationFails(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	c := auditConsumer(&fakeAuditDB{}, &fakeAuditRedis{groupErr: errors.New("redis down")})
	c.claimIdle = time.Hour

	c.Run(ctx)

	if c.Healthy() {
		t.Fatal("consumer must stay unhealthy when the group cannot be created")
	}
}

func TestConsumerRunBacksOffWhenStartupDrainFails(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	c := auditConsumer(&fakeAuditDB{}, &fakeAuditRedis{xreadGroups: []auditXReadResult{{err: errors.New("read down")}}})
	c.claimIdle = time.Hour

	c.Run(ctx)

	if c.Healthy() {
		t.Fatal("consumer must stay unhealthy when the startup drain fails")
	}
}

func TestConsumerRunBacksOffOnLiveReadFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	c := auditConsumer(&fakeAuditDB{}, &fakeAuditRedis{xreadGroups: []auditXReadResult{
		{err: redis.Nil},
		{err: redis.Nil},
		{err: errors.New("read down")},
	}})
	c.claimIdle = time.Hour

	c.Run(ctx)

	if c.Healthy() {
		t.Fatal("consumer must mark itself unhealthy after a live read failure")
	}
}

func TestSanitizeRawJSONKeepsUnparseablePayloads(t *testing.T) {
	raw := json.RawMessage(`{"key":"\u0000`)
	if got := sanitizeRawJSON(raw); string(got) != string(raw) {
		t.Fatalf("unparseable payload changed: %q", got)
	}
}
