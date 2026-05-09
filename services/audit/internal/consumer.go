// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis Streams consumer for the audit-ingestor group: PEL drain on startup,
// XAUTOCLAIM reaper for orphaned entries, DLQ for permanent failures,
// HMAC verification of producer-signed events.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

const (
	auditStream    = "caracal.audit.events"
	auditDLQStream = "caracal.audit.events.dlq"
	consumerGroup  = "audit-ingestor"
	consumeBatch   = 100
	consumeBackoff = time.Second
)

type Consumer struct {
	db           *PGWriter
	redis        *redis.Client
	log          zerolog.Logger
	consumerName string
	hmacKey      []byte
	maxDeliv     int64
	claimIdle    time.Duration

	parseErrors   atomic.Int64
	dlqTotal      atomic.Int64
	retriesTotal  atomic.Int64
	hmacFailTotal atomic.Int64
	tamperReplay  atomic.Int64
	healthy       atomic.Bool
}

func newConsumer(db *PGWriter, r *redis.Client, log zerolog.Logger, cfg Config) *Consumer {
	c := &Consumer{
		db:           db,
		redis:        r,
		log:          log,
		consumerName: cfg.ConsumerName,
		hmacKey:      cfg.HMACKey,
		maxDeliv:     cfg.MaxDeliveries,
		claimIdle:    time.Duration(cfg.ClaimIdleSecs) * time.Second,
	}
	c.healthy.Store(true)
	return c
}

func (c *Consumer) Run(ctx context.Context) {
	if err := ensureGroup(ctx, c.redis, auditStream, consumerGroup); err != nil {
		c.log.Error().Err(err).Msg("ensure consumer group")
	}

	if err := c.drainPEL(ctx); err != nil && !errors.Is(err, context.Canceled) {
		c.log.Error().Err(err).Msg("drain PEL on startup")
	}

	go c.reapLoop(ctx)

	for {
		if ctx.Err() != nil {
			return
		}
		msgs, err := c.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    consumerGroup,
			Consumer: c.consumerName,
			Streams:  []string{auditStream, ">"},
			Count:    consumeBatch,
			Block:    5 * time.Second,
		}).Result()
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			if errors.Is(err, redis.Nil) {
				continue
			}
			c.healthy.Store(false)
			c.log.Error().Err(err).Msg("xreadgroup")
			select {
			case <-ctx.Done():
				return
			case <-time.After(consumeBackoff):
			}
			continue
		}
		c.healthy.Store(true)
		for _, stream := range msgs {
			for _, msg := range stream.Messages {
				c.processOnce(ctx, msg, 1)
			}
		}
	}
}

// drainPEL re-processes any messages previously delivered to this consumer
// but never acknowledged (crashed in-flight).
func (c *Consumer) drainPEL(ctx context.Context) error {
	cursor := "0"
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		msgs, err := c.redis.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    consumerGroup,
			Consumer: c.consumerName,
			Streams:  []string{auditStream, cursor},
			Count:    consumeBatch,
			Block:    100 * time.Millisecond,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) {
				return nil
			}
			return err
		}
		if len(msgs) == 0 {
			return nil
		}
		processed := 0
		for _, stream := range msgs {
			if len(stream.Messages) == 0 {
				return nil
			}
			for _, msg := range stream.Messages {
				c.processOnce(ctx, msg, 1)
				cursor = msg.ID
				processed++
			}
		}
		if processed == 0 {
			return nil
		}
	}
}

// reapLoop periodically claims entries idle longer than claimIdle and re-attempts
// processing. Entries delivered more than maxDeliv times go to the DLQ.
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
		if ctx.Err() != nil {
			return
		}
		claimed, next, err := c.redis.XAutoClaim(ctx, &redis.XAutoClaimArgs{
			Stream:   auditStream,
			Group:    consumerGroup,
			Consumer: c.consumerName,
			MinIdle:  c.claimIdle,
			Start:    startID,
			Count:    consumeBatch,
		}).Result()
		if err != nil {
			c.log.Error().Err(err).Msg("xautoclaim")
			return
		}
		if len(claimed) == 0 {
			return
		}
		c.retriesTotal.Add(int64(len(claimed)))
		pending, _ := c.redis.XPendingExt(ctx, &redis.XPendingExtArgs{
			Stream: auditStream,
			Group:  consumerGroup,
			Start:  claimed[0].ID,
			End:    claimed[len(claimed)-1].ID,
			Count:  int64(len(claimed)),
		}).Result()
		delivByID := map[string]int64{}
		for _, p := range pending {
			delivByID[p.ID] = p.RetryCount
		}
		for _, msg := range claimed {
			c.processOnce(ctx, msg, delivByID[msg.ID])
		}
		if next == "0-0" || next == "" {
			return
		}
		startID = next
	}
}

// processOnce handles a single message with full classification of outcomes.
//   - inserted          → XACK
//   - benign duplicate  → XACK
//   - tamper-on-replay  → DLQ + alert + XACK
//   - parse / hmac fail → DLQ + XACK
//   - permanent PG err  → DLQ if delivCount >= maxDeliv, else leave in PEL
//   - transient err     → leave in PEL for reaper
func (c *Consumer) processOnce(ctx context.Context, msg redis.XMessage, delivCount int64) {
	raw, ok := msg.Values["data"].(string)
	if !ok {
		c.parseErrors.Add(1)
		c.toDLQ(ctx, msg, "missing_data_field")
		c.ack(ctx, msg.ID)
		return
	}
	sig, _ := msg.Values["sig"].(string)

	if !c.verifyHMAC(raw, sig) {
		c.hmacFailTotal.Add(1)
		c.toDLQ(ctx, msg, "hmac_verify_failed")
		c.ack(ctx, msg.ID)
		return
	}

	ev, err := unmarshalEvent(raw)
	if err != nil {
		c.parseErrors.Add(1)
		c.toDLQ(ctx, msg, "json_parse_error:"+err.Error())
		c.ack(ctx, msg.ID)
		return
	}

	_, err = c.db.Insert(ctx, ev, sig)
	if errors.Is(err, ErrConflictMismatch) {
		c.tamperReplay.Add(1)
		c.toDLQ(ctx, msg, "tamper_on_replay")
		c.ack(ctx, msg.ID)
		return
	}
	if err == nil {
		c.ack(ctx, msg.ID)
		return
	}

	if IsTransientPGError(err) {
		if c.maxDeliv > 0 && delivCount >= c.maxDeliv {
			c.toDLQ(ctx, msg, "transient_exceeded_max_deliveries:"+err.Error())
			c.ack(ctx, msg.ID)
			return
		}
		c.log.Warn().Err(err).Str("id", msg.ID).Int64("deliv", delivCount).Msg("transient pg insert; will retry")
		return
	}
	c.toDLQ(ctx, msg, "pg_permanent_error:"+err.Error())
	c.ack(ctx, msg.ID)
}

func (c *Consumer) ack(ctx context.Context, id string) {
	if err := c.redis.XAck(ctx, auditStream, consumerGroup, id).Err(); err != nil {
		c.log.Error().Err(err).Str("id", id).Msg("xack failed")
	}
}

func (c *Consumer) toDLQ(ctx context.Context, msg redis.XMessage, reason string) {
	c.dlqTotal.Add(1)
	fields := map[string]any{
		"reason":      reason,
		"src_id":      msg.ID,
		"received_at": strconv.FormatInt(time.Now().UnixMilli(), 10),
	}
	for k, v := range msg.Values {
		if s, ok := v.(string); ok {
			fields["src_"+k] = s
		}
	}
	if err := c.redis.XAdd(ctx, &redis.XAddArgs{
		Stream: auditDLQStream,
		Values: fields,
	}).Err(); err != nil {
		c.log.Error().Err(err).Str("id", msg.ID).Str("reason", reason).Msg("dlq publish failed")
	} else {
		c.log.Warn().Str("id", msg.ID).Str("reason", reason).Msg("event sent to DLQ")
	}
}

func (c *Consumer) verifyHMAC(raw, sig string) bool {
	if len(c.hmacKey) == 0 {
		return true
	}
	if sig == "" {
		return false
	}
	want, err := hex.DecodeString(sig)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, c.hmacKey)
	mac.Write([]byte(raw))
	return hmac.Equal(want, mac.Sum(nil))
}

func unmarshalEvent(raw string) (AuditEvent, error) {
	var ev AuditEvent
	if err := jsonUnmarshalStrict(raw, &ev); err != nil {
		return ev, err
	}
	if ev.ID == "" || ev.ZoneID == "" || ev.OccurredAt.IsZero() {
		return ev, errors.New("required fields missing (id, zone_id, occurred_at)")
	}
	return ev, nil
}

func ensureGroup(ctx context.Context, r *redis.Client, stream, group string) error {
	err := r.XGroupCreateMkStream(ctx, stream, group, "$").Err()
	if err != nil && strings.Contains(err.Error(), "BUSYGROUP") {
		return nil
	}
	return err
}

func (c *Consumer) Healthy() bool {
	return c.healthy.Load()
}
