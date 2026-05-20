// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Revocation cache: tracks revoked session, agent, and delegation ids and aborts affected gateway streams.

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

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

const (
	streamRevoke      = "caracal.sessions.revoke"
	groupRevoke       = "gateway-revocation"
	revocationTTL     = 24 * time.Hour
	revocationGCPause = 30 * time.Minute
	pendingIdle       = 30 * time.Second
	failureTTL        = 24 * time.Hour
	maxFailures       = 5
)

type revocationRedis interface {
	EnsureGroup(ctx context.Context, stream, group string) error
	XReadGroup(ctx context.Context, group, consumer, stream string, count int64) ([]redis.XMessage, error)
	XAutoClaim(ctx context.Context, group, consumer, stream, start string, minIdle time.Duration, count int64) ([]redis.XMessage, string, error)
	XAck(ctx context.Context, stream, group, id string) error
	VerifyStream(stream string, values map[string]any) bool
	SignedXAdd(ctx context.Context, stream string, values map[string]any) error
	IncrWithExpiry(ctx context.Context, key string, ttl time.Duration) (int64, error)
	Del(ctx context.Context, key string) error
}

// revocationStore answers revocation lookups for the gateway. It is populated
// by a background consumer reading the same caracal.sessions.revoke stream STS
// uses, so revocations propagate to the gateway in near real time. Entries are
// pruned after revocationTTL — by then any per-call token bound to that authority
// has long since expired (max ttlPerCallSDK = 15m).
type revocationStore struct {
	mu       sync.RWMutex
	sessions map[string]time.Time
	agents   map[string]time.Time
	edges    map[string]time.Time
	log      zerolog.Logger
}

func newRevocationStore(log zerolog.Logger) *revocationStore {
	return &revocationStore{sessions: map[string]time.Time{}, agents: map[string]time.Time{}, edges: map[string]time.Time{}, log: log}
}

// IsRevoked reports whether the session id has been revoked recently enough that
// any token bearing it must still be considered invalid.
func (s *revocationStore) IsRevoked(sid string) bool {
	if sid == "" {
		return false
	}
	s.mu.RLock()
	expiresAt, ok := s.sessions[sid]
	s.mu.RUnlock()
	return ok && time.Now().Before(expiresAt)
}

func (s *revocationStore) IsAgentRevoked(agentSessionID string) bool {
	if agentSessionID == "" {
		return false
	}
	s.mu.RLock()
	expiresAt, ok := s.agents[agentSessionID]
	s.mu.RUnlock()
	return ok && time.Now().Before(expiresAt)
}

func (s *revocationStore) IsDelegationRevoked(delegationEdgeID string) bool {
	if delegationEdgeID == "" {
		return false
	}
	s.mu.RLock()
	expiresAt, ok := s.edges[delegationEdgeID]
	s.mu.RUnlock()
	return ok && time.Now().Before(expiresAt)
}

func (s *revocationStore) markSession(sid string) {
	s.mu.Lock()
	s.sessions[sid] = time.Now().Add(revocationTTL)
	s.mu.Unlock()
}

func (s *revocationStore) markAgent(agentSessionID string) {
	s.mu.Lock()
	s.agents[agentSessionID] = time.Now().Add(revocationTTL)
	s.mu.Unlock()
}

func (s *revocationStore) markDelegation(delegationEdgeID string) {
	s.mu.Lock()
	s.edges[delegationEdgeID] = time.Now().Add(revocationTTL)
	s.mu.Unlock()
}

// Size reports how many active revocations are currently tracked.
func (s *revocationStore) Size() int {
	if s == nil {
		return 0
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.sessions) + len(s.agents) + len(s.edges)
}

func (s *revocationStore) prune() {
	cutoff := time.Now()
	s.mu.Lock()
	for sid, expiresAt := range s.sessions {
		if !cutoff.Before(expiresAt) {
			delete(s.sessions, sid)
		}
	}
	for agentSessionID, expiresAt := range s.agents {
		if !cutoff.Before(expiresAt) {
			delete(s.agents, agentSessionID)
		}
	}
	for delegationEdgeID, expiresAt := range s.edges {
		if !cutoff.Before(expiresAt) {
			delete(s.edges, delegationEdgeID)
		}
	}
	s.mu.Unlock()
}

// startRevocationConsumer subscribes to the revocation stream and populates store.
// It loops until ctx is cancelled. Returns an error when the consumer group cannot
// be ensured so the gateway refuses to start with revocations broken.
func startRevocationConsumer(ctx context.Context, redis revocationRedis, store *revocationStore, log zerolog.Logger) error {
	if redis == nil {
		return fmt.Errorf("revocation consumer requires redis")
	}
	if store == nil {
		return fmt.Errorf("revocation consumer requires store")
	}
	if err := redis.EnsureGroup(ctx, streamRevoke, groupRevoke); err != nil {
		return fmt.Errorf("revocation consumer ensure group: %w", err)
	}
	consumer := fmt.Sprintf("gateway-%s-%d", hostname(), os.Getpid())
	go runRevocationLoop(ctx, redis, store, consumer, log)
	go runRevocationGC(ctx, store)
	return nil
}

func runRevocationLoop(ctx context.Context, redis revocationRedis, store *revocationStore, consumer string, log zerolog.Logger) {
	replayPendingRevocations(ctx, redis, store, consumer, log)
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
		processRevocationMessages(ctx, redis, store, msgs, log)
	}
}

func replayPendingRevocations(ctx context.Context, redis revocationRedis, store *revocationStore, consumer string, log zerolog.Logger) {
	next := "0-0"
	for {
		msgs, start, err := redis.XAutoClaim(ctx, groupRevoke, consumer, streamRevoke, next, pendingIdle, 25)
		if err != nil {
			log.Error().Err(err).Msg("revocation claim pending failed")
			return
		}
		if len(msgs) == 0 {
			return
		}
		processRevocationMessages(ctx, redis, store, msgs, log)
		next = start
	}
}

func processRevocationMessages(ctx context.Context, redis revocationRedis, store *revocationStore, msgs []redis.XMessage, log zerolog.Logger) {
	for _, msg := range msgs {
		processRevocationMessage(ctx, redis, store, msg, log)
	}
}

func processRevocationMessage(ctx context.Context, redis revocationRedis, store *revocationStore, msg redis.XMessage, log zerolog.Logger) {
	if !redis.VerifyStream(streamRevoke, msg.Values) {
		log.Warn().Str("id", msg.ID).Msg("dropping revocation message with invalid origin signature")
		if err := redis.XAck(ctx, streamRevoke, groupRevoke, msg.ID); err != nil {
			log.Error().Err(err).Str("id", msg.ID).Msg("revocation xack invalid message failed")
		}
		return
	}
	sid, _ := msg.Values["session_id"].(string)
	agentSessionID, _ := msg.Values["agent_session_id"].(string)
	delegationEdgeID, _ := msg.Values["delegation_edge_id"].(string)
	if delegationEdgeID == "" {
		delegationEdgeID, _ = msg.Values["edge_id"].(string)
	}
	if sid == "" && agentSessionID == "" && delegationEdgeID == "" {
		trackRevocationFailure(ctx, redis, msg, fmt.Errorf("missing session_id, agent_session_id, or delegation_edge_id"), log)
		return
	}
	if sid != "" {
		store.markSession(sid)
	}
	if agentSessionID != "" {
		store.markAgent(agentSessionID)
	}
	if delegationEdgeID != "" {
		store.markDelegation(delegationEdgeID)
	}
	if err := redis.XAck(ctx, streamRevoke, groupRevoke, msg.ID); err != nil {
		log.Error().Err(err).Str("id", msg.ID).Msg("revocation xack failed")
	}
}

func jwtAgentSessionID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		AgentSessionID string `json:"agent_session_id"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return claims.AgentSessionID
}

func jwtDelegationEdgeID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		DelegationEdgeID string `json:"delegation_edge_id"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return claims.DelegationEdgeID
}

func jwtRootSID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		RootSID string `json:"root_sid"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return claims.RootSID
}

func trackRevocationFailure(ctx context.Context, redis revocationRedis, msg redis.XMessage, cause error, log zerolog.Logger) {
	key := "stream-failure:" + streamRevoke + ":" + msg.ID
	attempts, err := redis.IncrWithExpiry(ctx, key, failureTTL)
	if err != nil {
		log.Error().Err(err).Str("id", msg.ID).Msg("track revocation failure failed")
		return
	}
	if attempts < maxFailures {
		return
	}
	values, _ := json.Marshal(msg.Values)
	if err := redis.SignedXAdd(ctx, streamRevoke+".dead", map[string]any{
		"original_id": msg.ID,
		"error":       cause.Error(),
		"values":      string(values),
	}); err != nil {
		log.Error().Err(err).Str("id", msg.ID).Msg("dead-letter revocation message failed")
		return
	}
	if err := redis.XAck(ctx, streamRevoke, groupRevoke, msg.ID); err != nil {
		log.Error().Err(err).Str("id", msg.ID).Msg("revocation xack dead-lettered message failed")
		return
	}
	_ = redis.Del(ctx, key)
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
		Sid string `json:"sid"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return claims.Sid
}
