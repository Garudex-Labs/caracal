// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

const (
	resolveCacheTTL = 5 * time.Minute
	// resolveMiss caches "this name has no registry entry" so unregistered
	// agents cost one lookup per TTL, not one per delivery.
	resolveMiss = "__none__"
)

// resolveCache is the small cache surface the resolver needs. Reads and
// writes are best-effort: a broken cache degrades to database lookups.
type resolveCache interface {
	Get(ctx context.Context, key string) (value string, ok bool)
	Set(ctx context.Context, key, value string, ttl time.Duration)
}

// rowQuerier is the subset of a pgx pool the resolver needs.
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// AgentResolver normalizes session attribution inside the validated project.
// Unknown and foreign identifiers fail closed to unattributed telemetry.
type AgentResolver struct {
	DB    rowQuerier
	Cache resolveCache
}

// Resolve returns the canonical (agentID, agentVersion) pair.
func (r *AgentResolver) Resolve(ctx context.Context, projectID string, agentID, agentVersion *string) (*string, *string) {
	resolvedID := r.resolveID(ctx, projectID, agentID)
	return resolvedID, r.resolveVersion(ctx, projectID, resolvedID, agentVersion)
}

func (r *AgentResolver) resolveID(ctx context.Context, projectID string, agentID *string) *string {
	if agentID == nil || *agentID == "" || projectID == "" {
		return nil
	}
	identifier := *agentID
	cacheKey := "agent_resolve:" + projectID + ":" + identifier
	if cached, ok := r.Cache.Get(ctx, cacheKey); ok {
		if cached == resolveMiss {
			return nil
		}
		return &cached
	}

	var resolved string
	err := r.DB.QueryRow(ctx, `SELECT id FROM agents
		WHERE project_id = $1 AND (id::text = $2 OR name = $2) LIMIT 1`, projectID, identifier).Scan(&resolved)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		r.Cache.Set(ctx, cacheKey, resolveMiss, resolveCacheTTL)
		return nil
	case err != nil:
		slog.Warn("agent id resolution failed", "error", err)
		return nil
	}
	r.Cache.Set(ctx, cacheKey, resolved, resolveCacheTTL)
	return &resolved
}

func (r *AgentResolver) resolveVersion(ctx context.Context, projectID string, agentID, agentVersion *string) *string {
	if agentVersion == nil || *agentVersion != "latest" || agentID == nil || !isUUID(*agentID) {
		return agentVersion
	}
	cacheKey := "agent_version_resolve:" + projectID + ":" + *agentID + ":latest"
	if cached, ok := r.Cache.Get(ctx, cacheKey); ok {
		if cached == resolveMiss {
			return agentVersion
		}
		return &cached
	}

	var resolved string
	err := r.DB.QueryRow(ctx,
		`SELECT av.version FROM agent_versions av
		 JOIN agents a ON a.latest_version_id = av.id
		 WHERE a.project_id = $1 AND a.id = $2 LIMIT 1`, projectID, *agentID).Scan(&resolved)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		r.Cache.Set(ctx, cacheKey, resolveMiss, resolveCacheTTL)
		return agentVersion
	case err != nil:
		slog.Warn("agent version resolution failed", "error", err)
		return agentVersion
	}
	r.Cache.Set(ctx, cacheKey, resolved, resolveCacheTTL)
	return &resolved
}

func isUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}

// RedisCache adapts a Redis client to the resolver's cache surface.
type RedisCache struct {
	Client redis.Cmdable
}

func (c RedisCache) Get(ctx context.Context, key string) (string, bool) {
	value, err := c.Client.Get(ctx, key).Result()
	if err != nil {
		return "", false
	}
	return value, true
}

func (c RedisCache) Set(ctx context.Context, key, value string, ttl time.Duration) {
	if err := c.Client.Set(ctx, key, value, ttl).Err(); err != nil {
		slog.Debug("resolver cache write failed", "key", key, "error", err)
	}
}
