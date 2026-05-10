// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Ordered Redis Streams consumer relay for caracal.agents.lifecycle.

package internal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/core/config"
	sharedcrypto "github.com/garudex-labs/caracal/core/crypto"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

const (
	lifecycleStream = "caracal.agents.lifecycle"
	consumerGroup   = "coordinator-relay"
	consumerName    = "relay-0"
)

type Consumer struct {
	redis      *redis.Client
	log        zerolog.Logger
	hmacKey    []byte
	requireSig bool
	dedupeTTL  time.Duration
}

func New(_ context.Context) (*Consumer, error) {
	redisURL := config.MustGetenv("REDIS_URL")
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	r := redis.NewClient(opts)
	log := zerolog.New(os.Stderr).With().Timestamp().Logger()

	base := config.Load()
	hmacKey, err := sharedcrypto.DecodeStreamKey(config.Getenv("STREAMS_HMAC_KEY", ""))
	if err != nil {
		return nil, err
	}
	if base.IsProduction() && len(hmacKey) == 0 {
		return nil, errors.New("STREAMS_HMAC_KEY is required in production")
	}
	if len(hmacKey) == 0 {
		log.Warn().Msg("STREAMS_HMAC_KEY not set; lifecycle events will not be origin-verified")
	}
	dedupeSec := 3600
	if raw := config.Getenv("RELAY_DEDUPE_WINDOW_SEC", ""); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("invalid RELAY_DEDUPE_WINDOW_SEC: %s", raw)
		}
		dedupeSec = n
	}
	return &Consumer{
		redis: r, log: log, hmacKey: hmacKey,
		requireSig: base.IsProduction(),
		dedupeTTL:  time.Duration(dedupeSec) * time.Second,
	}, nil
}

func (c *Consumer) Run(ctx context.Context) {
	if err := c.ensureGroup(ctx); err != nil {
		c.log.Error().Err(err).Msg("ensure consumer group")
	}

	for {
		if ctx.Err() != nil {
			return
		}
		msgs, err := c.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    consumerGroup,
			Consumer: consumerName,
			Streams:  []string{lifecycleStream, ">"},
			Count:    50,
			Block:    5 * time.Second,
		}).Result()
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			if errors.Is(err, redis.Nil) {
				continue
			}
			c.log.Error().Err(err).Msg("xreadgroup")
			time.Sleep(time.Second)
			continue
		}
		for _, stream := range msgs {
			for _, msg := range stream.Messages {
				if !c.verify(msg.Values) {
					c.log.Warn().Str("id", msg.ID).Msg("dropping lifecycle event with invalid origin signature")
					c.redis.XAck(ctx, lifecycleStream, consumerGroup, msg.ID)
					continue
				}
				if c.duplicate(ctx, msg.Values) {
					c.log.Debug().Str("id", msg.ID).Msg("skipping duplicate lifecycle event")
					c.redis.XAck(ctx, lifecycleStream, consumerGroup, msg.ID)
					continue
				}
				c.log.Info().
					Str("id", msg.ID).
					Interface("event", msg.Values["event"]).
					Interface("zone_id", msg.Values["zone_id"]).
					Msg("lifecycle event")
				c.redis.XAck(ctx, lifecycleStream, consumerGroup, msg.ID)
			}
		}
	}
}

func (c *Consumer) verify(values map[string]any) bool {
	if !c.requireSig && len(c.hmacKey) == 0 {
		return true
	}
	return sharedcrypto.VerifyStream(c.hmacKey, lifecycleStream, values)
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
