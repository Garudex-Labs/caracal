// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Ordered Redis Streams consumer relay for caracal.agents.lifecycle.

package internal

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/config"
	sharedcrypto "github.com/garudex-labs/caracal/packages/core/go/crypto"
	"github.com/garudex-labs/caracal/packages/core/go/logging"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

const (
	lifecycleStream = "caracal.agents.lifecycle"
	consumerGroup   = "coordinator-relay"
	consumeBatch    = 50
	consumeBackoff  = time.Second
)

type Config struct {
	RedisURL      string
	StreamHMACKey []byte
	RequireSig    bool
	ConsumerName  string
	DedupeTTL     time.Duration
	ClaimIdle     time.Duration
}

type Consumer struct {
	redis         *redis.Client
	log           zerolog.Logger
	streamHMACKey []byte
	requireSig    bool
	consumerName  string
	dedupeTTL     time.Duration
	claimIdle     time.Duration
}

func New(_ context.Context) (*Consumer, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, err
	}
	r := redis.NewClient(opts)
	log := logging.New("coordinator-relay")
	return &Consumer{
		redis: r, log: log, streamHMACKey: cfg.StreamHMACKey,
		requireSig:   cfg.RequireSig,
		consumerName: cfg.ConsumerName,
		dedupeTTL:    cfg.DedupeTTL,
		claimIdle:    cfg.ClaimIdle,
	}, nil
}

func loadConfig() (Config, error) {
	config.ResolveFileSecrets("REDIS_URL", "STREAMS_HMAC_KEY")
	if missing := config.MissingRequired("REDIS_URL"); len(missing) > 0 {
		return Config{}, fmt.Errorf("required env vars missing: %s", strings.Join(missing, ", "))
	}
	streamHMACKey, err := sharedcrypto.DecodeStreamKey(config.Getenv("STREAMS_HMAC_KEY", ""))
	if err != nil {
		return Config{}, err
	}
	requireSig := config.Mode() != "dev"
	if requireSig && len(streamHMACKey) == 0 {
		return Config{}, errors.New("STREAMS_HMAC_KEY is required when CARACAL_MODE=rc or CARACAL_MODE=stable")
	}
	dedupeSec, err := positiveSeconds("RELAY_DEDUPE_WINDOW_SEC", 3600)
	if err != nil {
		return Config{}, err
	}
	claimIdleSec, err := positiveSeconds("RELAY_CLAIM_IDLE_SEC", 60)
	if err != nil {
		return Config{}, err
	}
	return Config{
		RedisURL:      config.Getenv("REDIS_URL", ""),
		StreamHMACKey: streamHMACKey,
		RequireSig:    requireSig,
		ConsumerName:  config.Getenv("RELAY_CONSUMER_NAME", config.Getenv("HOSTNAME", "coordinator-relay-0")),
		DedupeTTL:     time.Duration(dedupeSec) * time.Second,
		ClaimIdle:     time.Duration(claimIdleSec) * time.Second,
	}, nil
}

func positiveSeconds(name string, fallback int) (int, error) {
	raw := config.Getenv(name, "")
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("invalid %s: %s", name, raw)
	}
	return n, nil
}

func (c *Consumer) Run(ctx context.Context) error {
	if len(c.streamHMACKey) == 0 {
		c.log.Warn().Msg("STREAMS_HMAC_KEY not set; lifecycle events will not be origin-verified")
	}
	for {
		if ctx.Err() != nil {
			return nil
		}
		if err := c.ensureGroup(ctx); err != nil {
			c.log.Error().Err(err).Msg("ensure consumer group")
		} else if err := c.drainPEL(ctx); err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			c.log.Error().Err(err).Msg("drain PEL on startup")
		} else {
			break
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(consumeBackoff):
		}
	}

	go c.reapLoop(ctx)

	for {
		if ctx.Err() != nil {
			return nil
		}
		msgs, err := c.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    consumerGroup,
			Consumer: c.consumerName,
			Streams:  []string{lifecycleStream, ">"},
			Count:    consumeBatch,
			Block:    5 * time.Second,
		}).Result()
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			if errors.Is(err, redis.Nil) {
				continue
			}
			c.log.Error().Err(err).Msg("xreadgroup")
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
			}
			continue
		}
		for _, stream := range msgs {
			for _, msg := range stream.Messages {
				c.processMessage(ctx, msg)
			}
		}
	}
}

func (c *Consumer) drainPEL(ctx context.Context) error {
	cursor := "0"
	for {
		msgs, err := c.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    consumerGroup,
			Consumer: c.consumerName,
			Streams:  []string{lifecycleStream, cursor},
			Count:    consumeBatch,
			Block:    100 * time.Millisecond,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) {
				return nil
			}
			return err
		}
		processed := 0
		for _, stream := range msgs {
			if len(stream.Messages) == 0 {
				return nil
			}
			for _, msg := range stream.Messages {
				c.processMessage(ctx, msg)
				cursor = msg.ID
				processed++
			}
		}
		if processed == 0 {
			return nil
		}
	}
}

func (c *Consumer) reapLoop(ctx context.Context) {
	t := time.NewTicker(c.claimIdle)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.reapOnce(ctx)
		}
	}
}

func (c *Consumer) reapOnce(ctx context.Context) {
	startID := "0-0"
	for {
		claimed, next, err := c.redis.XAutoClaim(ctx, &redis.XAutoClaimArgs{
			Stream:   lifecycleStream,
			Group:    consumerGroup,
			Consumer: c.consumerName,
			MinIdle:  c.claimIdle,
			Start:    startID,
			Count:    consumeBatch,
		}).Result()
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				c.log.Error().Err(err).Msg("xautoclaim")
			}
			return
		}
		for _, msg := range claimed {
			c.processMessage(ctx, msg)
		}
		if len(claimed) == 0 || next == "0-0" || next == "" {
			return
		}
		startID = next
	}
}

func (c *Consumer) processMessage(ctx context.Context, msg redis.XMessage) {
	if !c.verify(msg.Values) {
		c.log.Warn().Str("id", msg.ID).Msg("dropping lifecycle event with invalid origin signature")
		c.ack(ctx, msg.ID)
		return
	}
	if c.duplicate(ctx, msg.Values) {
		c.log.Debug().Str("id", msg.ID).Msg("skipping duplicate lifecycle event")
		c.ack(ctx, msg.ID)
		return
	}
	c.log.Info().
		Str("id", msg.ID).
		Str("event", stringVal(msg.Values["event"])).
		Str("zone_id", stringVal(msg.Values["zone_id"])).
		Msg("lifecycle event")
	c.ack(ctx, msg.ID)
}

func (c *Consumer) ack(ctx context.Context, id string) {
	if err := c.redis.XAck(ctx, lifecycleStream, consumerGroup, id).Err(); err != nil {
		c.log.Error().Err(err).Str("id", id).Msg("xack failed")
	}
}

func (c *Consumer) verify(values map[string]any) bool {
	if !c.requireSig && len(c.streamHMACKey) == 0 {
		return true
	}
	return sharedcrypto.VerifyStream(c.streamHMACKey, lifecycleStream, values)
}

func (c *Consumer) duplicate(ctx context.Context, values map[string]any) bool {
	id, ok := values["outbox_id"].(string)
	if !ok || id == "" {
		return false
	}
	key := fmt.Sprintf("coordinator:relay_dedupe:%s", id)
	set, err := c.redis.SetNX(ctx, key, "1", c.dedupeTTL).Result()
	if err != nil {
		c.log.Warn().Err(err).Str("id", id).Msg("dedupe setnx failed; proceeding")
		return false
	}
	return !set
}

func (c *Consumer) ensureGroup(ctx context.Context) error {
	err := c.redis.XGroupCreateMkStream(ctx, lifecycleStream, consumerGroup, "$").Err()
	if err != nil && strings.Contains(err.Error(), "BUSYGROUP") {
		return nil
	}
	return err
}

func stringVal(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
