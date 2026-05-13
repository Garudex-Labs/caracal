// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis-backed revocation store and stream consumer for resource servers.

package revocationredis

import (
	"context"
	"fmt"
	"strings"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/core/crypto"
	"github.com/redis/go-redis/v9"
)

const (
	// RevocationStream is the Redis stream carrying session revocation events.
	RevocationStream = "caracal.sessions.revoke"
	// DefaultRevocationTTL is the default duration for cached revoked sessions.
	DefaultRevocationTTL = 24 * time.Hour
)

// KeyClient is the Redis key operation subset needed by Store.
type KeyClient interface {
	Get(ctx context.Context, key string) *redis.StringCmd
	Set(ctx context.Context, key string, value any, expiration time.Duration) *redis.StatusCmd
}

// Store implements revocation.Store using Redis keys.
type Store struct {
	redis      KeyClient
	keyPrefix  string
	defaultTTL time.Duration
	timeout    time.Duration
	failClosed bool
}

// Option configures Store.
type Option func(*Store)

// WithKeyPrefix sets the Redis key prefix for revoked session ids.
func WithKeyPrefix(prefix string) Option {
	return func(s *Store) { s.keyPrefix = prefix }
}

// WithDefaultTTL sets the revocation TTL used when MarkRevoked receives no TTL.
func WithDefaultTTL(ttl time.Duration) Option {
	return func(s *Store) { s.defaultTTL = ttl }
}

// WithTimeout sets the per-command timeout.
func WithTimeout(timeout time.Duration) Option {
	return func(s *Store) { s.timeout = timeout }
}

// WithFailClosed controls lookup behavior when Redis is unavailable.
func WithFailClosed(failClosed bool) Option {
	return func(s *Store) { s.failClosed = failClosed }
}

// NewStore returns a Redis-backed revocation store.
func NewStore(redis KeyClient, opts ...Option) *Store {
	s := &Store{
		redis:      redis,
		keyPrefix:  "caracal:revoked:sessions:",
		defaultTTL: DefaultRevocationTTL,
		timeout:    2 * time.Second,
		failClosed: true,
	}
	for _, opt := range opts {
		opt(s)
	}
	if s.defaultTTL <= 0 {
		s.defaultTTL = DefaultRevocationTTL
	}
	if s.timeout <= 0 {
		s.timeout = 2 * time.Second
	}
	return s
}

// IsRevoked reports whether sid has an unexpired revocation key.
func (s *Store) IsRevoked(sid string) bool {
	if sid == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	defer cancel()
	_, err := s.redis.Get(ctx, s.key(sid)).Result()
	if err == nil {
		return true
	}
	if err == redis.Nil {
		return false
	}
	return s.failClosed
}

// MarkRevoked records sid as revoked for ttl.
func (s *Store) MarkRevoked(sid string, ttl time.Duration) {
	if sid == "" {
		return
	}
	if ttl <= 0 {
		ttl = s.defaultTTL
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
	defer cancel()
	_ = s.redis.Set(ctx, s.key(sid), "1", ttl).Err()
}

func (s *Store) key(sid string) string {
	return s.keyPrefix + sid
}

// StreamClient is the Redis stream operation subset needed by Consumer.
type StreamClient interface {
	KeyClient
	XAck(ctx context.Context, stream, group string, ids ...string) *redis.IntCmd
	XGroupCreateMkStream(ctx context.Context, stream, group, start string) *redis.StatusCmd
	XReadGroup(ctx context.Context, a *redis.XReadGroupArgs) *redis.XStreamSliceCmd
}

// Consumer reads signed revocation stream messages and populates a Store.
type Consumer struct {
	redis            StreamClient
	store            *Store
	stream           string
	group            string
	consumer         string
	batchSize        int64
	block            time.Duration
	streamHMACKey    []byte
	requireSignature bool
}

// ConsumerOption configures Consumer.
type ConsumerOption func(*Consumer)

// WithStream sets the stream name.
func WithStream(stream string) ConsumerOption {
	return func(c *Consumer) { c.stream = stream }
}

// WithGroup sets the consumer group name.
func WithGroup(group string) ConsumerOption {
	return func(c *Consumer) { c.group = group }
}

// WithBatchSize sets the maximum number of messages read per poll.
func WithBatchSize(size int64) ConsumerOption {
	return func(c *Consumer) { c.batchSize = size }
}

// WithBlock sets the XREADGROUP block duration.
func WithBlock(block time.Duration) ConsumerOption {
	return func(c *Consumer) { c.block = block }
}

// WithStreamHMAC configures revocation stream origin verification.
func WithStreamHMAC(key []byte, require bool) ConsumerOption {
	return func(c *Consumer) {
		c.streamHMACKey = key
		c.requireSignature = require
	}
}

// NewConsumer returns a Redis stream consumer that populates store.
func NewConsumer(redis StreamClient, store *Store, consumer string, opts ...ConsumerOption) (*Consumer, error) {
	c := &Consumer{
		redis:     redis,
		store:     store,
		stream:    RevocationStream,
		group:     "resource-revocation",
		consumer:  consumer,
		batchSize: 50,
	}
	for _, opt := range opts {
		opt(c)
	}
	if c.consumer == "" {
		return nil, fmt.Errorf("consumer is required")
	}
	if c.batchSize <= 0 {
		c.batchSize = 50
	}
	if c.requireSignature && len(c.streamHMACKey) == 0 {
		return nil, fmt.Errorf("stream hmac key is required when signatures are required")
	}
	return c, nil
}

// EnsureGroup creates the revocation consumer group when needed.
func (c *Consumer) EnsureGroup(ctx context.Context) error {
	err := c.redis.XGroupCreateMkStream(ctx, c.stream, c.group, "0").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return err
	}
	return nil
}

// PollOnce reads and applies one batch of revocation messages.
func (c *Consumer) PollOnce(ctx context.Context) (int, error) {
	streams, err := c.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    c.group,
		Consumer: c.consumer,
		Streams:  []string{c.stream, ">"},
		Count:    c.batchSize,
		Block:    c.block,
	}).Result()
	if err != nil {
		if err == redis.Nil {
			return 0, nil
		}
		return 0, err
	}
	handled := 0
	for _, stream := range streams {
		for _, msg := range stream.Messages {
			if err := c.processMessage(ctx, msg); err != nil {
				return handled, err
			}
			handled++
		}
	}
	return handled, nil
}

func (c *Consumer) processMessage(ctx context.Context, msg redis.XMessage) error {
	if !c.verify(msg.Values) {
		return c.redis.XAck(ctx, c.stream, c.group, msg.ID).Err()
	}
	sid, _ := msg.Values["session_id"].(string)
	if sid != "" {
		c.store.MarkRevoked(sid, 0)
	}
	return c.redis.XAck(ctx, c.stream, c.group, msg.ID).Err()
}

func (c *Consumer) verify(values map[string]any) bool {
	if !c.requireSignature && len(c.streamHMACKey) == 0 {
		return true
	}
	return sharedcrypto.VerifyStream(c.streamHMACKey, c.stream, values)
}
