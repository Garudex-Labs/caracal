// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Minimal Redis client used by the gateway for JTI replay detection, audit emission, and revocation propagation.

package internal

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisClient struct{ c *redis.Client }

func newRedis(dsn string) (*RedisClient, error) {
	opts, err := redis.ParseURL(dsn)
	if err != nil {
		return nil, err
	}
	return &RedisClient{c: redis.NewClient(opts)}, nil
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

// EnsureGroup creates a Redis consumer group (MKSTREAM) if it does not exist.
func (r *RedisClient) EnsureGroup(ctx context.Context, stream, group string) error {
	err := r.c.XGroupCreateMkStream(ctx, stream, group, "$").Err()
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

// XAck acknowledges a delivered stream message so it is not redelivered.
func (r *RedisClient) XAck(ctx context.Context, stream, group, id string) error {
	return r.c.XAck(ctx, stream, group, id).Err()
}
