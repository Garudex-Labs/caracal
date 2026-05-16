// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JTI replay cache: rejects a token id seen within its lifetime. In-memory implementation for single-replica deployments; Redis-backed implementation for multi-replica deployments.

package internal

import (
	"context"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Replay is the contract every control replica shares to block repeated JTIs within a token's lifetime.
type Replay interface {
	Mark(jti string, exp time.Time) bool
	Ping(ctx context.Context) error
}

type ReplayCache struct {
	mu      sync.Mutex
	seen    map[string]time.Time
	ttl     time.Duration
	maxKeys int
}

func NewReplayCache(ttl time.Duration) *ReplayCache {
	return &ReplayCache{seen: map[string]time.Time{}, ttl: ttl, maxKeys: 100_000}
}

// Mark records jti and returns false if it has already been seen within ttl.
func (c *ReplayCache) Mark(jti string, exp time.Time) bool {
	if jti == "" {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	c.evict(now)
	if _, ok := c.seen[jti]; ok {
		return false
	}
	if len(c.seen) >= c.maxKeys {
		return false
	}
	keepUntil := exp
	if keepUntil.IsZero() || keepUntil.After(now.Add(c.ttl)) {
		keepUntil = now.Add(c.ttl)
	}
	c.seen[jti] = keepUntil
	return true
}

func (c *ReplayCache) evict(now time.Time) {
	for k, t := range c.seen {
		if !t.After(now) {
			delete(c.seen, k)
		}
	}
}

// RedisReplay shares JTI state across replicas via Redis SET NX EX.
type RedisReplay struct {
	client    *redis.Client
	keyPrefix string
	maxTTL    time.Duration
}

func NewRedisReplay(client *redis.Client, maxTTL time.Duration) *RedisReplay {
	return &RedisReplay{client: client, keyPrefix: "caracal:control:jti:", maxTTL: maxTTL}
}

func (r *RedisReplay) Mark(jti string, exp time.Time) bool {
	if jti == "" {
		return true
	}
	now := time.Now()
	ttl := r.maxTTL
	if !exp.IsZero() {
		if d := exp.Sub(now); d > 0 && d < ttl {
			ttl = d
		}
	}
	if ttl <= 0 {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ok, err := r.client.SetNX(ctx, r.keyPrefix+jti, "1", ttl).Result()
	if err != nil {
		// Fail closed: if Redis is unreachable we cannot prove non-replay.
		return false
	}
	return ok
}

func (r *RedisReplay) Ping(ctx context.Context) error {
	return r.client.Ping(ctx).Err()
}

func (c *ReplayCache) Ping(_ context.Context) error { return nil }
