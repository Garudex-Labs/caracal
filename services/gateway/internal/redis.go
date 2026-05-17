// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Minimal Redis client used by the gateway for JTI replay detection, audit emission, and revocation propagation.

package internal

import (
	"context"
	"fmt"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/crypto"
	"github.com/redis/go-redis/v9"
)

type RedisClient struct {
	c           *redis.Client
	streamHMAC  []byte
	requireSigs bool
}

func newRedis(dsn string) (*RedisClient, error) {
	opts, err := redis.ParseURL(dsn)
	if err != nil {
		return nil, err
	}
	return &RedisClient{c: redis.NewClient(opts)}, nil
}

// Ping checks Redis connectivity for readiness.
func (r *RedisClient) Ping(ctx context.Context) error {
	return r.c.Ping(ctx).Err()
}

// SetStreamSigning configures origin verification for Redis stream messages.
func (r *RedisClient) SetStreamSigning(key []byte, require bool) {
	r.streamHMAC = key
	r.requireSigs = require
}

// VerifyStream reports whether a stream message was signed by a trusted producer.
func (r *RedisClient) VerifyStream(stream string, values map[string]any) bool {
	if !r.requireSigs && len(r.streamHMAC) == 0 {
		return true
	}
	return crypto.VerifyStream(r.streamHMAC, stream, values)
}

// SetNXTTL stores value at key only if it does not already exist, with the given TTL.
// Returns true when the key was newly created and false when it already existed.
func (r *RedisClient) SetNXTTL(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	return r.c.SetNX(ctx, key, value, ttl).Result()
}

// XAdd appends an entry to a Redis stream.
func (r *RedisClient) XAdd(ctx context.Context, stream string, values map[string]any) error {
	return r.c.XAdd(ctx, &redis.XAddArgs{Stream: stream, Values: values}).Err()
}

// SignedXAdd appends an origin-signed entry to a Redis stream.
func (r *RedisClient) SignedXAdd(ctx context.Context, stream string, values map[string]any) error {
	if r.requireSigs && len(r.streamHMAC) == 0 {
		return fmt.Errorf("stream signing required but no key configured")
	}
	if sig := crypto.SignStream(r.streamHMAC, stream, values); sig != "" {
		values[crypto.StreamSigField] = sig
	}
	return r.XAdd(ctx, stream, values)
}

// EnsureGroup creates a Redis consumer group (MKSTREAM) if it does not exist.
func (r *RedisClient) EnsureGroup(ctx context.Context, stream, group string) error {
	err := r.c.XGroupCreateMkStream(ctx, stream, group, "0").Err()
	if err != nil && err.Error() == "BUSYGROUP Consumer Group name already exists" {
		return nil
	}
	return err
}

// XReadGroup blocks for up to one second waiting for new entries in stream that
// have not been delivered to consumer in group.
func (r *RedisClient) XReadGroup(ctx context.Context, group, consumer, stream string, count int64) ([]redis.XMessage, error) {
	streams, err := r.c.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    group,
		Consumer: consumer,
		Streams:  []string{stream, ">"},
		Count:    count,
		Block:    time.Second,
	}).Result()
	if err != nil {
		if err == redis.Nil {
			return nil, nil
		}
		return nil, err
	}
	if len(streams) == 0 {
		return nil, nil
	}
	return streams[0].Messages, nil
}

// XAutoClaim claims stale pending stream messages from crashed consumers.
func (r *RedisClient) XAutoClaim(ctx context.Context, group, consumer, stream, start string, minIdle time.Duration, count int64) ([]redis.XMessage, string, error) {
	msgs, next, err := r.c.XAutoClaim(ctx, &redis.XAutoClaimArgs{
		Stream:   stream,
		Group:    group,
		Consumer: consumer,
		MinIdle:  minIdle,
		Start:    start,
		Count:    count,
	}).Result()
	return msgs, next, err
}

// XAck acknowledges a delivered stream message so it is not redelivered.
func (r *RedisClient) XAck(ctx context.Context, stream, group, id string) error {
	return r.c.XAck(ctx, stream, group, id).Err()
}

// IncrWithExpiry atomically increments key and sets TTL on first increment.
func (r *RedisClient) IncrWithExpiry(ctx context.Context, key string, ttl time.Duration) (int64, error) {
	script := `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c`
	return r.c.Eval(ctx, script, []string{key}, int(ttl.Seconds())).Int64()
}

// Del removes keys from Redis.
func (r *RedisClient) Del(ctx context.Context, key string) error {
	return r.c.Del(ctx, key).Err()
}
