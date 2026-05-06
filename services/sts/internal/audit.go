// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Non-blocking audit event buffer: ring channel flushed every 50ms or 1k events.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
)

const (
	auditBufCap   = 10_000
	auditFlushN   = 1_000
	auditFlushTTL = 50 * time.Millisecond
	auditStream   = "caracal.audit.events"
)

// AuditBuffer decouples audit emission from the hot token-exchange path.
type AuditBuffer struct {
	ch      chan AuditEvent
	redis   *RedisClient
	log     zerolog.Logger
	dropped atomic.Uint64
	hmacKey []byte
}

func newAuditBuffer(redis *RedisClient, log zerolog.Logger) *AuditBuffer {
	var key []byte
	if hexKey := os.Getenv("AUDIT_HMAC_KEY"); hexKey != "" {
		k, err := hex.DecodeString(hexKey)
		if err == nil && len(k) >= 32 {
			key = k
		} else {
			log.Warn().Msg("AUDIT_HMAC_KEY invalid; audit events will be unsigned")
		}
	} else {
		log.Warn().Msg("AUDIT_HMAC_KEY not set; audit events will be unsigned")
	}
	return &AuditBuffer{
		ch:      make(chan AuditEvent, auditBufCap),
		redis:   redis,
		log:     log,
		hmacKey: key,
	}
}

// Emit enqueues an audit event and records pressure when the buffer is full.
// A nil receiver is a no-op so unit tests that exercise the exchange path
// without a configured Redis sink do not need to wire one up.
func (a *AuditBuffer) Emit(event AuditEvent) {
	if a == nil {
		return
	}
	select {
	case a.ch <- event:
	default:
		dropped := a.dropped.Add(1)
		if dropped == 1 || dropped%1000 == 0 {
			a.log.Warn().Uint64("dropped", dropped).Msg("audit buffer full")
		}
	}
}

func (a *AuditBuffer) Dropped() uint64 {
	return a.dropped.Load()
}

func (a *AuditBuffer) sign(data []byte) string {
	if len(a.hmacKey) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, a.hmacKey)
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

// start launches the background flusher goroutine.
func (a *AuditBuffer) start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(auditFlushTTL)
		defer ticker.Stop()
		batch := make([]AuditEvent, 0, auditFlushN)

		flush := func() {
			for _, ev := range batch {
				data, err := json.Marshal(ev)
				if err != nil {
					a.log.Error().Err(err).Str("id", ev.ID).Msg("marshal audit event")
					continue
				}
				values := map[string]interface{}{
					"id":   ev.ID,
					"data": string(data),
				}
				if sig := a.sign(data); sig != "" {
					values["sig"] = sig
				}
				if err := a.redis.XAdd(ctx, auditStream, values); err != nil {
					a.log.Error().Err(err).Str("id", ev.ID).Msg("xadd audit event")
				}
			}
			batch = batch[:0]
		}

		for {
			select {
			case ev := <-a.ch:
				batch = append(batch, ev)
				if len(batch) >= auditFlushN {
					flush()
				}
			case <-ticker.C:
				if len(batch) > 0 {
					flush()
				}
			case <-ctx.Done():
				flush()
				return
			}
		}
	}()
}
