// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Revocation cache: tracks revoked session ids and aborts in-flight gateway streams when a session is revoked.

package internal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

const (
	streamRevoke      = "caracal.sessions.revoke"
	groupRevoke       = "gateway-revocation"
	revocationTTL     = 24 * time.Hour
	revocationGCPause = 30 * time.Minute
)

// revocationStore answers IsRevoked(sid) lookups for the gateway. It is populated
// by a background consumer reading the same caracal.sessions.revoke stream STS
// uses, so revocations propagate to the gateway in near real time. Entries are
// pruned after revocationTTL — by then any per-call token bound to that session
// has long since expired (max ttlPerCallSDK = 15m).
type revocationStore struct {
	mu      sync.RWMutex
	entries map[string]time.Time
	log     zerolog.Logger
}

func newRevocationStore(log zerolog.Logger) *revocationStore {
	return &revocationStore{entries: map[string]time.Time{}, log: log}
}

// IsRevoked reports whether the session id has been revoked recently enough that
// any token bearing it must still be considered invalid.
func (s *revocationStore) IsRevoked(sid string) bool {
	if s == nil || sid == "" {
		return false
	}
	s.mu.RLock()
	expiresAt, ok := s.entries[sid]
	s.mu.RUnlock()
	return ok && time.Now().Before(expiresAt)
}

func (s *revocationStore) mark(sid string) {
	s.mu.Lock()
	s.entries[sid] = time.Now().Add(revocationTTL)
	s.mu.Unlock()
}

func (s *revocationStore) prune() {
	cutoff := time.Now()
	s.mu.Lock()
	for sid, expiresAt := range s.entries {
		if !cutoff.Before(expiresAt) {
			delete(s.entries, sid)
		}
	}
	s.mu.Unlock()
}

// startRevocationConsumer subscribes to the revocation stream and populates store.
// It loops until ctx is cancelled. A nil redis client makes this a no-op so
// deployments without REDIS_URL still serve traffic (with revocation propagation
// disabled — STS validation at exchange time remains the trust root).
func startRevocationConsumer(ctx context.Context, redis *RedisClient, store *revocationStore, log zerolog.Logger) {
	if redis == nil || store == nil {
		log.Warn().Msg("revocation consumer disabled (no redis client)")
		return
	}
	if err := redis.EnsureGroup(ctx, streamRevoke, groupRevoke); err != nil {
		log.Error().Err(err).Msg("revocation consumer ensure group failed")
		return
	}
	consumer := fmt.Sprintf("gateway-%s-%d", hostname(), os.Getpid())
	go runRevocationLoop(ctx, redis, store, consumer, log)
	go runRevocationGC(ctx, store)
}

func runRevocationLoop(ctx context.Context, redis *RedisClient, store *revocationStore, consumer string, log zerolog.Logger) {
	for {
		if ctx.Err() != nil {
			return
		}
		msgs, err := redis.XReadGroup(ctx, groupRevoke, consumer, streamRevoke, 50)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Error().Err(err).Msg("revocation consumer read failed")
			time.Sleep(time.Second)
			continue
		}
		for _, msg := range msgs {
			sid, _ := msg.Values["session_id"].(string)
			if sid != "" {
				store.mark(sid)
			}
			if err := redis.XAck(ctx, streamRevoke, groupRevoke, msg.ID); err != nil {
				log.Error().Err(err).Str("id", msg.ID).Msg("revocation xack failed")
			}
		}
	}
}

func runRevocationGC(ctx context.Context, store *revocationStore) {
	ticker := time.NewTicker(revocationGCPause)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			store.prune()
		}
	}
}

func hostname() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "unknown"
	}
	return host
}

// jwtSID extracts the sid (session id) claim from a JWT without verifying its
// signature. Used by the gateway's revocation pre-flight check; trust root is
// the STS validation that happens during token exchange.
func jwtSID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Sid            string `json:"sid"`
		AgentSessionID string `json:"agent_session_id"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	if claims.Sid != "" {
		return claims.Sid
	}
	return claims.AgentSessionID
}
