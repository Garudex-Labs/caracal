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
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

const (
	streamRevoke       = "caracal.sessions.revoke"
	groupRevoke        = "gateway-revocation"
	revocationTTL      = 24 * time.Hour
	revocationGCPause  = 30 * time.Minute
	snapshotPoll       = 30 * time.Second
	snapshotStaleAfter = 2*snapshotPoll + 10*time.Second
	pendingIdle        = 30 * time.Second
	failureTTL         = 24 * time.Hour
	maxFailures        = 5
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
// pruned after revocationTTL: by then any resource mandate bound to that authority
// has long since expired (max ttlResourceMandate = 15m).
type revocationStore struct {
	mu           sync.RWMutex
	sessions     map[string]time.Time
	agents       map[string]time.Time
	edges        map[string]time.Time
	snapshotUnix atomic.Int64
	log          zerolog.Logger
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

func applyRevocationSnapshot(store *revocationStore, sessions, agents, edges []string) {
	for _, sid := range sessions {
		store.markSession(sid)
	}
	for _, agentSessionID := range agents {
		store.markAgent(agentSessionID)
	}
	for _, delegationEdgeID := range edges {
		store.markDelegation(delegationEdgeID)
	}
}

func (s *revocationStore) markSnapshotFresh(now time.Time) {
	s.snapshotUnix.Store(now.Unix())
}

func (s *revocationStore) SnapshotAge(now time.Time) (time.Duration, bool) {
	if s == nil {
		return 0, false
	}
	seen := s.snapshotUnix.Load()
	if seen <= 0 {
		return 0, false
	}
	age := now.Sub(time.Unix(seen, 0))
	if age < 0 {
		return 0, false
	}
	return age, true
}

func (s *revocationStore) SnapshotFresh(now time.Time) bool {
	age, ok := s.SnapshotAge(now)
	return ok && age <= snapshotStaleAfter
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
func startRevocationConsumer(ctx context.Context, redis revocationRedis, store *revocationStore, metrics *GatewayMetrics, log zerolog.Logger) error {
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
	go runRevocationLoop(ctx, redis, store, consumer, metrics, log)
	go runRevocationPendingReaper(ctx, redis, store, consumer, metrics, log)
	go runRevocationGC(ctx, store)
	return nil
}

func reloadRevocationSnapshot(ctx context.Context, pool *pgxpool.Pool, store *revocationStore) error {
	if pool == nil {
		return fmt.Errorf("revocation snapshot requires postgres")
	}
	if store == nil {
		return fmt.Errorf("revocation snapshot requires store")
	}
	sessions, err := queryRevocationIDs(ctx, pool,
		`SELECT id FROM sessions
		 WHERE status = 'revoked'
		   AND expires_at > now() - ($1::int * interval '1 second')`,
		int(revocationTTL.Seconds()),
	)
	if err != nil {
		return err
	}
	agents, err := queryRevocationIDs(ctx, pool,
		`SELECT id FROM agent_sessions
		 WHERE status IN ('suspended', 'terminated')
		   AND updated_at > now() - ($1::int * interval '1 second')`,
		int(revocationTTL.Seconds()),
	)
	if err != nil {
		return err
	}
	edges, err := queryRevocationIDs(ctx, pool,
		`SELECT id FROM delegation_edges
		 WHERE status = 'revoked'
		   AND revoked_at IS NOT NULL
		   AND revoked_at > now() - ($1::int * interval '1 second')`,
		int(revocationTTL.Seconds()),
	)
	if err != nil {
		return err
	}
	applyRevocationSnapshot(store, sessions, agents, edges)
	store.markSnapshotFresh(time.Now())
	return nil
}

func queryRevocationIDs(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) ([]string, error) {
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

func startRevocationSnapshotPolling(ctx context.Context, pool *pgxpool.Pool, store *revocationStore, metrics *GatewayMetrics, log zerolog.Logger) {
	ticker := time.NewTicker(snapshotPoll)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := reloadRevocationSnapshot(ctx, pool, store); err != nil {
					if metrics != nil {
						metrics.RevocationReloadErrors.Add(1)
					}
					log.Error().Err(err).Msg("revocation snapshot reload failed")
				} else if metrics != nil {
					metrics.RevocationReloads.Add(1)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

func runRevocationLoop(ctx context.Context, redis revocationRedis, store *revocationStore, consumer string, metrics *GatewayMetrics, log zerolog.Logger) {
	replayPendingRevocations(ctx, redis, store, consumer, metrics, log)
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
		processRevocationMessages(ctx, redis, store, msgs, metrics, log)
	}
}

func runRevocationPendingReaper(ctx context.Context, redis revocationRedis, store *revocationStore, consumer string, metrics *GatewayMetrics, log zerolog.Logger) {
	ticker := time.NewTicker(pendingIdle)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			replayPendingRevocations(ctx, redis, store, consumer, metrics, log)
		}
	}
}

func replayPendingRevocations(ctx context.Context, redis revocationRedis, store *revocationStore, consumer string, metrics *GatewayMetrics, log zerolog.Logger) {
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
		if metrics != nil {
			metrics.RevocationPendingReplayed.Add(uint64(len(msgs)))
		}
		processRevocationMessages(ctx, redis, store, msgs, metrics, log)
		next = start
	}
}

func processRevocationMessages(ctx context.Context, redis revocationRedis, store *revocationStore, msgs []redis.XMessage, metrics *GatewayMetrics, log zerolog.Logger) {
	for _, msg := range msgs {
		processRevocationMessage(ctx, redis, store, msg, metrics, log)
	}
}

func processRevocationMessage(ctx context.Context, redis revocationRedis, store *revocationStore, msg redis.XMessage, metrics *GatewayMetrics, log zerolog.Logger) {
	if !redis.VerifyStream(streamRevoke, msg.Values) {
		log.Warn().Str("id", msg.ID).Msg("dropping revocation message with invalid origin signature")
		if metrics != nil {
			metrics.RevocationInvalidSignatures.Add(1)
		}
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
		trackRevocationFailure(ctx, redis, msg, fmt.Errorf("missing session_id, agent_session_id, or delegation_edge_id"), metrics, log)
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
	if metrics != nil {
		metrics.RevocationMessages.Add(1)
		if age, ok := streamMessageAge(msg.ID, time.Now()); ok {
			metrics.RevocationPropagationSeconds.Store(uint64(age / time.Second))
		}
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

func trackRevocationFailure(ctx context.Context, redis revocationRedis, msg redis.XMessage, cause error, metrics *GatewayMetrics, log zerolog.Logger) {
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
	if metrics != nil {
		metrics.RevocationDeadLetters.Add(1)
	}
	_ = redis.Del(ctx, key)
}

func streamMessageAge(id string, now time.Time) (time.Duration, bool) {
	raw, _, ok := strings.Cut(id, "-")
	if !ok || raw == "" {
		return 0, false
	}
	var millis int64
	if _, err := fmt.Sscanf(raw, "%d", &millis); err != nil {
		return 0, false
	}
	age := now.Sub(time.UnixMilli(millis))
	if age < 0 {
		return 0, true
	}
	return age, true
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
