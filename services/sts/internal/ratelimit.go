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
	rateLimitWindow  = time.Minute
	rateLimitMax     = int64(1000)
	authRateLimitMax = int64(60)
)

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

// checkRateLimit enforces a fixed-window 1000 req/min limit per zone+resource.
// Fails closed when Redis is unreachable so a backend outage cannot lift caps.
func (s *Server) checkRateLimit(ctx context.Context, zoneID, resourceID, actorID string) *sharederr.CaracalError {
	if s.redis == nil {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit unavailable")
	}
	key := fmt.Sprintf("rl:%s:%s:%s", zoneID, resourceID, actorID)
	count, err := s.redis.IncrWithExpiry(ctx, key, rateLimitWindow)
	if err != nil {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit unavailable")
	}
	if count > rateLimitMax {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit exceeded")
	}
	return nil
}
