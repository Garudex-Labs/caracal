// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Minimal Redis client used by the gateway for JTI replay detection and audit emission.

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
func (r *RedisClient) XAdd(ctx context.Context, stream string, values map[string]interface{}) error {
	return r.c.XAdd(ctx, &redis.XAddArgs{Stream: stream, Values: values}).Err()
}
