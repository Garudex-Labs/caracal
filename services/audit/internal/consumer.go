// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis Streams consumer for the audit-ingestor group: PEL drain on startup,
// XAUTOCLAIM reaper for orphaned entries, DLQ for permanent failures,
// HMAC verification of producer-signed events.

package internal

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/garudex-labs/caracal/packages/core/go/redisguard"
)

const (
	auditStream    = "caracal.audit.events"
	auditDLQStream = "caracal.audit.events.dlq"
	consumerGroup  = "audit-ingestor"
	consumeBatch   = 100
	consumeBackoff = time.Second
)

type Consumer struct {
	db           auditInserter
	redis        auditStreamClient
	log          zerolog.Logger
	consumerName string
	auditHMACKey []byte
	maxDeliv     int64
	claimIdle    time.Duration

	parseErrors   atomic.Int64
	dlqTotal      atomic.Int64
	retriesTotal  atomic.Int64
	hmacFailTotal atomic.Int64
	tamperReplay  atomic.Int64
	healthy       atomic.Bool
}

type auditInserter interface {
	Insert(context.Context, AuditEvent, string) (InsertResult, error)
}

type auditStreamClient interface {
	XAck(context.Context, string, string, ...string) *redis.IntCmd
	XAdd(context.Context, *redis.XAddArgs) *redis.StringCmd
	XAutoClaim(context.Context, *redis.XAutoClaimArgs) *redis.XAutoClaimCmd
	XGroupCreateMkStream(context.Context, string, string, string) *redis.StatusCmd
	XPendingExt(context.Context, *redis.XPendingExtArgs) *redis.XPendingExtCmd
	XReadGroup(context.Context, *redis.XReadGroupArgs) *redis.XStreamSliceCmd
	ConfigGet(context.Context, string) *redis.MapStringStringCmd
}

func newConsumer(db auditInserter, r auditStreamClient, log zerolog.Logger, cfg Config) *Consumer {
	return &Consumer{
		db:           db,
		redis:        r,
		log:          log,
		consumerName: cfg.ConsumerName,
		auditHMACKey: cfg.AuditHMACKey,
		maxDeliv:     cfg.MaxDeliveries,
		claimIdle:    time.Duration(cfg.ClaimIdleSecs) * time.Second,
	}
}

func (c *Consumer) Run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := ensureGroup(ctx, c.redis, auditStream, consumerGroup); err != nil {
			c.healthy.Store(false)
			c.log.Error().Err(err).Msg("ensure consumer group")
			select {
			case <-ctx.Done():
				return
			case <-time.After(consumeBackoff):
			}
			continue
		}
		if err := c.drainPEL(ctx); err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			c.healthy.Store(false)
			c.log.Error().Err(err).Msg("drain PEL on startup")
			select {
			case <-ctx.Done():
				return
			case <-time.After(consumeBackoff):
			}
			continue
		}
		c.healthy.Store(true)
		break
	}

	// Redis is reachable and the group is ready here. Warn if its eviction
	// policy could silently drop audit stream entries; never blocks startup.
	redisguard.WarnIfUnsafeEviction(ctx, func(ctx context.Context) (string, error) {
		m, err := c.redis.ConfigGet(ctx, redisguard.EvictionPolicyParam).Result()
		if err != nil {
			return "", err
		}
		return m[redisguard.EvictionPolicyParam], nil
	}, c.log)

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

// drainPEL re-processes messages delivered to this consumer but never
// acknowledged before a crash.
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
		pending, err := c.redis.XPendingExt(ctx, &redis.XPendingExtArgs{
			Stream: auditStream,
			Group:  consumerGroup,
			Start:  claimed[0].ID,
			End:    claimed[len(claimed)-1].ID,
			Count:  int64(len(claimed)),
		}).Result()
		if err != nil {
			c.healthy.Store(false)
			c.log.Error().Err(err).Msg("xpendingext")
			return
		}
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
//   - tamper-on-replay  → DLQ + alert, XACK only if the DLQ write succeeds
//   - parse / hmac fail → DLQ, XACK only if the DLQ write succeeds
//   - permanent PG err  → DLQ if delivCount >= maxDeliv, XACK only on DLQ success
//   - transient err     → leave in PEL for reaper
//
// A message is never acknowledged unless it was durably persisted or durably
// dead-lettered, so a failed DLQ write leaves it in the PEL for retry rather
// than dropping the audit event.
func (c *Consumer) processOnce(ctx context.Context, msg redis.XMessage, delivCount int64) {
	raw, ok := msg.Values["data"].(string)
	if !ok {
		c.parseErrors.Add(1)
		c.dlqAndAck(ctx, msg, "missing_data_field")
		return
	}
	sig, _ := msg.Values["sig"].(string)

	if !c.verifyHMAC(raw, sig) {
		c.hmacFailTotal.Add(1)
		c.dlqAndAck(ctx, msg, "hmac_verify_failed")
		return
	}

	ev, err := unmarshalEvent(raw)
	if err != nil {
		c.parseErrors.Add(1)
		c.dlqAndAck(ctx, msg, "json_parse_error:"+err.Error())
		return
	}

	_, err = c.db.Insert(ctx, sanitizeEvent(ev), sig)
	if errors.Is(err, ErrConflictMismatch) {
		c.tamperReplay.Add(1)
		c.dlqAndAck(ctx, msg, "tamper_on_replay")
		return
	}
	if err == nil {
		c.ack(ctx, msg.ID)
		return
	}

	if IsTransientPGError(err) {
		if c.maxDeliv > 0 && delivCount >= c.maxDeliv {
			c.dlqAndAck(ctx, msg, "transient_exceeded_max_deliveries:"+err.Error())
			return
		}
		c.log.Warn().Err(err).Str("id", msg.ID).Int64("deliv", delivCount).Msg("transient pg insert; will retry")
		return
	}
	c.dlqAndAck(ctx, msg, "pg_permanent_error:"+err.Error())
}

func (c *Consumer) ack(ctx context.Context, id string) {
	if err := c.redis.XAck(ctx, auditStream, consumerGroup, id).Err(); err != nil {
		c.log.Error().Err(err).Str("id", id).Msg("xack failed")
	}
}

// dlqAndAck routes a message to the DLQ and acknowledges it only when the DLQ
// write succeeds. A failed DLQ write leaves the message in the PEL so the reaper
// retries it later: acking a message that was never dead-lettered would drop the
// audit event entirely, breaking the durability contract.
func (c *Consumer) dlqAndAck(ctx context.Context, msg redis.XMessage, reason string) {
	if c.toDLQ(ctx, msg, reason) {
		c.ack(ctx, msg.ID)
	}
}

// toDLQ publishes a message to the dead-letter stream. It reports whether the
// publish succeeded so the caller can decide whether the source message may be
// acknowledged. The dlq counter tracks events that actually reached the DLQ.
func (c *Consumer) toDLQ(ctx context.Context, msg redis.XMessage, reason string) bool {
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
		c.log.Error().Err(err).Str("id", msg.ID).Str("reason", reason).Msg("dlq publish failed; leaving in PEL for retry")
		return false
	}
	c.dlqTotal.Add(1)
	c.log.Warn().Str("id", msg.ID).Str("reason", reason).Msg("event sent to DLQ")
	return true
}

func (c *Consumer) verifyHMAC(raw, sig string) bool {
	if len(c.auditHMACKey) == 0 {
		return true
	}
	if sig == "" {
		return false
	}
	want, err := hex.DecodeString(sig)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, c.auditHMACKey)
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

// sanitizeEvent strips NUL characters, which Postgres rejects in text and jsonb
// values, from every string field so a crafted but HMAC-valid payload cannot
// force its own audit record into the dead-letter queue and suppress it.
func sanitizeEvent(ev AuditEvent) AuditEvent {
	ev.ID = stripNul(ev.ID)
	ev.ZoneID = stripNul(ev.ZoneID)
	ev.EventType = stripNul(ev.EventType)
	ev.RequestID = stripNul(ev.RequestID)
	ev.Decision = stripNul(ev.Decision)
	ev.PolicySetID = stripNul(ev.PolicySetID)
	ev.PolicySetVersionID = stripNul(ev.PolicySetVersionID)
	ev.ManifestSHA = stripNul(ev.ManifestSHA)
	ev.EvaluationStatus = stripNul(ev.EvaluationStatus)
	ev.DeterminingPoliciesJSON = sanitizeRawJSON(ev.DeterminingPoliciesJSON)
	ev.DiagnosticsJSON = sanitizeRawJSON(ev.DiagnosticsJSON)
	ev.MetadataJSON = sanitizeRawJSON(ev.MetadataJSON)
	return ev
}

func stripNul(s string) string {
	if !strings.Contains(s, "\x00") {
		return s
	}
	return strings.ReplaceAll(s, "\x00", "")
}

// sanitizeRawJSON rewrites a JSON document whose strings contain NUL escapes.
// Valid JSON can only carry NUL as the \u0000 escape, so documents without that
// sequence pass through untouched.
func sanitizeRawJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || !bytes.Contains(raw, []byte(`\u0000`)) {
		return raw
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw
	}
	out, err := json.Marshal(sanitizeJSONValue(v))
	if err != nil {
		return raw
	}
	return out
}

func sanitizeJSONValue(v any) any {
	switch t := v.(type) {
	case string:
		return stripNul(t)
	case []any:
		for i, e := range t {
			t[i] = sanitizeJSONValue(e)
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[stripNul(k)] = sanitizeJSONValue(e)
		}
		return out
	default:
		return v
	}
}

func ensureGroup(ctx context.Context, r auditStreamClient, stream, group string) error {
	err := r.XGroupCreateMkStream(ctx, stream, group, "$").Err()
	if err != nil && strings.Contains(err.Error(), "BUSYGROUP") {
		return nil
	}
	return err
}

func (c *Consumer) Healthy() bool {
	return c.healthy.Load()
}
