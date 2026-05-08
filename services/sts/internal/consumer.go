// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Redis stream consumers: session revocation, OPA policy invalidation, and key rotation.

package internal

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

const (
	streamRevoke = "caracal.sessions.revoke"
	streamPolicy = "caracal.policy.invalidate"
	streamKeys   = "caracal.keys.invalidate"
	groupRevoke  = "sts-revocation"
	groupPolicy  = "opa-engine"
	groupKeys    = "sts-keys"
	pendingIdle  = 30 * time.Second
	failureTTL   = 24 * time.Hour
	maxFailures  = 5
)

// startConsumers creates consumer groups and starts background reader goroutines.
func (s *Server) startConsumers(ctx context.Context) {
	_ = s.redis.EnsureGroup(ctx, streamRevoke, groupRevoke)
	_ = s.redis.EnsureGroup(ctx, streamPolicy, groupPolicy)
	_ = s.redis.EnsureGroup(ctx, streamKeys, groupKeys)

	baseConsumer := uniqueConsumerID("sts")
	go s.consumeRevocations(ctx, baseConsumer+"-revocations")
	go s.consumePolicyInvalidations(ctx, baseConsumer+"-policy")
	go s.consumeKeyInvalidations(ctx, baseConsumer+"-keys")
}

func (s *Server) consumeRevocations(ctx context.Context, consumer string) {
	s.replayPending(ctx, streamRevoke, groupRevoke, consumer, s.handleRevocation)
	for {
		if ctx.Err() != nil {
			return
		}
		msgs, err := s.redis.XReadGroup(ctx, groupRevoke, consumer, streamRevoke, 10)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.log.Error().Err(err).Msg("revocation consumer read")
			time.Sleep(time.Second)
			continue
		}
		for _, msg := range msgs {
			s.processMessage(ctx, streamRevoke, groupRevoke, streamMessage{ID: msg.ID, Values: msg.Values}, s.handleRevocation)
		}
	}
}

func (s *Server) consumePolicyInvalidations(ctx context.Context, consumer string) {
	s.replayPending(ctx, streamPolicy, groupPolicy, consumer, s.handlePolicyInvalidation)
	for {
		if ctx.Err() != nil {
			return
		}
		msgs, err := s.redis.XReadGroup(ctx, groupPolicy, consumer, streamPolicy, 10)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.log.Error().Err(err).Msg("policy invalidation consumer read")
			time.Sleep(time.Second)
			continue
		}
		for _, msg := range msgs {
			s.processMessage(ctx, streamPolicy, groupPolicy, streamMessage{ID: msg.ID, Values: msg.Values}, s.handlePolicyInvalidation)
		}
	}
}

func (s *Server) handleRevocation(ctx context.Context, msg streamMessage) error {
	zoneID, _ := msg.Values["zone_id"].(string)
	sid, _ := msg.Values["session_id"].(string)
	if zoneID == "" {
		return fmt.Errorf("missing zone_id")
	}
	if sid == "" {
		return fmt.Errorf("missing session_id")
	}
	return s.db.RevokeSession(ctx, zoneID, sid)
}

// handlePolicyInvalidation reloads the OPA bundle for the zone so an authoring
// change takes effect on the next decision.
func (s *Server) handlePolicyInvalidation(ctx context.Context, msg streamMessage) error {
	zoneID, _ := msg.Values["zone_id"].(string)
	if zoneID == "" {
		return fmt.Errorf("missing zone_id")
	}
	return s.opa.Reload(ctx, zoneID)
}

func (s *Server) consumeKeyInvalidations(ctx context.Context, consumer string) {
	s.replayPending(ctx, streamKeys, groupKeys, consumer, s.handleKeyInvalidation)
	for {
		if ctx.Err() != nil {
			return
		}
		msgs, err := s.redis.XReadGroup(ctx, groupKeys, consumer, streamKeys, 10)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.log.Error().Err(err).Msg("key invalidation consumer read")
			time.Sleep(time.Second)
			continue
		}
		for _, msg := range msgs {
			s.processMessage(ctx, streamKeys, groupKeys, streamMessage{ID: msg.ID, Values: msg.Values}, s.handleKeyInvalidation)
		}
	}
}

// handleKeyInvalidation flushes the in-process signing-key cache for the zone
// so a rotation is honored on the next token issuance instead of waiting out
// the cache TTL.
func (s *Server) handleKeyInvalidation(_ context.Context, msg streamMessage) error {
	zoneID, _ := msg.Values["zone_id"].(string)
	if zoneID == "" {
		return fmt.Errorf("missing zone_id")
	}
	if s.keys != nil {
		s.keys.Invalidate(zoneID)
	}
	return nil
}

type streamMessage struct {
	ID     string
	Values map[string]interface{}
}

func (s *Server) replayPending(ctx context.Context, stream, group, consumer string, handle func(context.Context, streamMessage) error) {
	next := "0-0"
	for {
		msgs, start, err := s.redis.XAutoClaim(ctx, group, consumer, stream, next, pendingIdle, 25)
		if err != nil {
			s.log.Error().Err(err).Str("stream", stream).Msg("claim pending")
			return
		}
		if len(msgs) == 0 {
			return
		}
		for _, msg := range msgs {
			s.processMessage(ctx, stream, group, streamMessage{ID: msg.ID, Values: msg.Values}, handle)
		}
		next = start
	}
}

func (s *Server) processMessage(ctx context.Context, stream, group string, msg streamMessage, handle func(context.Context, streamMessage) error) {
	if !s.redis.VerifyStream(stream, msg.Values) {
		s.log.Warn().Str("id", msg.ID).Str("stream", stream).Msg("dropping stream message with invalid origin signature")
		if err := s.redis.XAck(ctx, stream, group, msg.ID); err != nil {
			s.log.Error().Err(err).Str("id", msg.ID).Str("stream", stream).Msg("xack unsigned message")
		}
		return
	}
	if err := handle(ctx, msg); err != nil {
		s.log.Error().Err(err).Str("id", msg.ID).Str("stream", stream).Msg("stream side effect")
		s.trackFailure(ctx, stream, group, msg, err)
		return
	}
	if err := s.redis.XAck(ctx, stream, group, msg.ID); err != nil {
		s.log.Error().Err(err).Str("id", msg.ID).Str("stream", stream).Msg("xack")
	}
}

func (s *Server) trackFailure(ctx context.Context, stream, group string, msg streamMessage, cause error) {
	key := "stream-failure:" + stream + ":" + msg.ID
	attempts, err := s.redis.IncrWithExpiry(ctx, key, failureTTL)
	if err != nil {
		s.log.Error().Err(err).Str("id", msg.ID).Str("stream", stream).Msg("track stream failure")
		return
	}
	if attempts < maxFailures {
		return
	}
	values, _ := json.Marshal(msg.Values)
	if err := s.redis.SignedXAdd(ctx, stream+".dead", map[string]interface{}{
		"original_id": msg.ID,
		"error":       cause.Error(),
		"values":      string(values),
	}); err != nil {
		s.log.Error().Err(err).Str("id", msg.ID).Str("stream", stream).Msg("dead-letter stream message")
		return
	}
	if err := s.redis.XAck(ctx, stream, group, msg.ID); err != nil {
		s.log.Error().Err(err).Str("id", msg.ID).Str("stream", stream).Msg("xack dead-lettered message")
		return
	}
	_ = s.redis.Del(ctx, key)
}

func uniqueConsumerID(prefix string) string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown"
	}
	return fmt.Sprintf("%s-%s-%d", prefix, host, os.Getpid())
}
