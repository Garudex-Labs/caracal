// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fixed per-zone-resource rate limiting using Redis atomic counters.

package internal

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
)

const (
	rateLimitWindow         = time.Minute
	defaultMintRateLimit    = int64(1000)
	authRateLimitMax        = int64(60)
	mintRateRefreshInterval = 30 * time.Second
)

// effectiveMintRateLimit resolves the enforced per-minute mint budget.
// STS_MINT_RATE_LIMIT_PER_MIN is the deployment ceiling; the console-managed
// override applies only when set and below that ceiling, so operators can
// tighten the working limit from the web console but never exceed what the
// deployment provisioned for.
func (s *Server) effectiveMintRateLimit() int64 {
	limit := int64(s.cfg.MintRateLimitPerMin)
	if limit <= 0 {
		limit = defaultMintRateLimit
	}
	if override := s.mintRateOverride.Load(); override > 0 && override < limit {
		limit = override
	}
	return limit
}

// startMintRateRefresh polls the console-managed override so a change applies
// without a restart. A read failure keeps the last known value: the limit itself
// stays enforced either way.
func (s *Server) startMintRateRefresh(ctx context.Context) {
	s.refreshMintRateOverride(ctx)
	t := time.NewTicker(mintRateRefreshInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.refreshMintRateOverride(ctx)
		}
	}
}

func (s *Server) refreshMintRateOverride(ctx context.Context) {
	limit, ok, err := s.db.ConfiguredMintRateLimit(ctx)
	if err != nil {
		s.log.Warn().Err(err).Msg("mint rate limit: read configured override")
		return
	}
	if !ok {
		s.mintRateOverride.Store(0)
		return
	}
	s.mintRateOverride.Store(limit)
}

func authenticationRateLimitKey(applicationID string) string {
	digest := sha256.Sum256([]byte(applicationID))
	return fmt.Sprintf("auth-rl:%x", digest[:])
}

// checkAuthenticationRateLimit rejects an application whose recent failed-secret
// attempts crossed the fleet-wide ceiling. Successful authentication never consumes
// this budget.
func (s *Server) checkAuthenticationRateLimit(ctx context.Context, applicationID string) *sharederr.CaracalError {
	if s.redis == nil {
		return sharederr.New(sharederr.ProviderRateLimited, "authentication rate limit unavailable")
	}
	blocked, err := s.redis.Exists(ctx, authenticationRateLimitKey(applicationID)+":blocked")
	if err != nil {
		return sharederr.New(sharederr.ProviderRateLimited, "authentication rate limit unavailable")
	}
	if blocked {
		return sharederr.New(sharederr.ProviderRateLimited, "authentication rate limit exceeded")
	}
	return nil
}

func (s *Server) recordAuthenticationFailure(ctx context.Context, applicationID string) *sharederr.CaracalError {
	key := authenticationRateLimitKey(applicationID)
	count, err := s.redis.IncrWithExpiry(ctx, key, rateLimitWindow)
	if err != nil {
		return sharederr.New(sharederr.ProviderRateLimited, "authentication rate limit unavailable")
	}
	if count > authRateLimitMax {
		if err := s.redis.SetTTL(ctx, key+":blocked", "1", rateLimitWindow); err != nil {
			return sharederr.New(sharederr.ProviderRateLimited, "authentication rate limit unavailable")
		}
		return sharederr.New(sharederr.ProviderRateLimited, "authentication rate limit exceeded")
	}
	return nil
}

// checkRateLimit enforces the configured fixed-window per-minute limit for each
// zone, resource, and acting application. Fails closed when Redis is unreachable
// so a backend outage cannot lift caps.
func (s *Server) checkRateLimit(ctx context.Context, zoneID, resourceID, actorID string) *sharederr.CaracalError {
	if s.redis == nil {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit unavailable")
	}
	key := fmt.Sprintf("rl:%s:%s:%s", zoneID, resourceID, actorID)
	count, err := s.redis.IncrWithExpiry(ctx, key, rateLimitWindow)
	if err != nil {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit unavailable")
	}
	if count > s.effectiveMintRateLimit() {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit exceeded")
	}
	return nil
}
