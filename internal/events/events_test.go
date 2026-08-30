// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package events

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/redis/go-redis/v9"
)

// fakeRedis embeds the client interface so it satisfies UniversalClient with
// nil methods, and overrides only Publish to record calls and inject errors.
type fakeRedis struct {
	redis.UniversalClient
	mu       sync.Mutex
	channels []string
	messages [][]byte
	err      error
}

func (f *fakeRedis) Publish(ctx context.Context, channel string, message any) *redis.IntCmd {
	f.mu.Lock()
	f.channels = append(f.channels, channel)
	if b, ok := message.([]byte); ok {
		f.messages = append(f.messages, b)
	}
	f.mu.Unlock()
	cmd := redis.NewIntCmd(ctx)
	if f.err != nil {
		cmd.SetErr(f.err)
	}
	return cmd
}

func TestPublishMarshalsPayloadToChannel(t *testing.T) {
	fake := &fakeRedis{}
	p := &RedisPublisher{Client: fake}

	payload := map[string]string{"kind": "agent", "id": "a1"}
	p.Publish(context.Background(), "notifications", payload)

	if len(fake.channels) != 1 || fake.channels[0] != "notifications" {
		t.Fatalf("channels = %v", fake.channels)
	}
	if len(fake.messages) != 1 {
		t.Fatalf("messages = %v", fake.messages)
	}
	var got map[string]string
	if err := json.Unmarshal(fake.messages[0], &got); err != nil {
		t.Fatalf("published message is not JSON: %v", err)
	}
	if got["kind"] != "agent" || got["id"] != "a1" {
		t.Errorf("payload roundtrip = %v", got)
	}
}

func TestPublishEmptyPayload(t *testing.T) {
	fake := &fakeRedis{}
	p := &RedisPublisher{Client: fake}
	p.Publish(context.Background(), "ch", map[string]string{})
	if len(fake.messages) != 1 || string(fake.messages[0]) != "{}" {
		t.Errorf("empty payload = %q", fake.messages)
	}
}

// Publishing is best-effort: a Redis failure is swallowed, never panics or
// propagates, so a lost nudge only delays a UI refresh.
func TestPublishSwallowsRedisError(t *testing.T) {
	fake := &fakeRedis{err: errors.New("connection refused")}
	p := &RedisPublisher{Client: fake}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Publish panicked on redis error: %v", r)
		}
	}()
	p.Publish(context.Background(), "ch", map[string]string{"k": "v"})

	// The call still reached Redis; only the returned error was dropped.
	if len(fake.channels) != 1 {
		t.Errorf("channels = %v", fake.channels)
	}
}
