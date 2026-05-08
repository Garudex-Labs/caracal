// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Per-zone-resource rate limiting using Redis atomic counters.

package internal

import (
	"context"
	"fmt"
	"time"

	sharederr "github.com/garudex-labs/caracal/shared/errors"
)

const (
	rateLimitWindow = time.Minute
	rateLimitMax    = int64(1000)
)

// checkRateLimit enforces a fixed-window 1000 req/min limit per zone+resource.
// Fails closed when Redis is unreachable so a backend outage cannot lift caps.
func (s *Server) checkRateLimit(ctx context.Context, zoneID, resourceID, actorID string) *sharederr.CaracalError {
	if s.redis == nil {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit unavailable")
	}
	window := rateLimitWindow
	maxRequests := rateLimitMax
	if limit, err := s.db.GetResourceRateLimit(ctx, zoneID, resourceID); err == nil {
		window = limit.Window
		maxRequests = limit.Max
	}
	key := fmt.Sprintf("rl:%s:%s:%s", zoneID, resourceID, actorID)
	count, err := s.redis.IncrWithExpiry(ctx, key, window)
	if err != nil {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit unavailable")
	}
	if count > maxRequests {
		return sharederr.New(sharederr.ProviderRateLimited, "rate limit exceeded")
	}
	return nil
}
