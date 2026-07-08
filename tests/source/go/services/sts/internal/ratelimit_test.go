// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Rate limit unit tests.

package internal

import (
	"context"
	"testing"
)

func TestCheckRateLimitFailsClosedWhenRedisUnavailable(t *testing.T) {
	s := &Server{db: &stubDB{}, redis: nil}
	if err := s.checkRateLimit(context.Background(), "z1", "res-1", "app-1"); err == nil {
		t.Error("rate limit must fail closed when redis is unavailable")
	}
}
