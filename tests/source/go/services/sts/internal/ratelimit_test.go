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

func TestAuthenticationRateLimitRunsBeforeSecretVerification(t *testing.T) {
	redis := newMemSTSRedis()
	s := &Server{redis: redis}
	for i := int64(0); i < authRateLimitMax; i++ {
		if err := s.recordAuthenticationFailure(context.Background(), "app-1"); err != nil {
			t.Fatalf("failure %d unexpectedly blocked: %v", i, err)
		}
	}
	if err := s.recordAuthenticationFailure(context.Background(), "app-1"); err == nil {
		t.Fatal("authentication failures against one application must be bounded")
	}
	if err := s.checkAuthenticationRateLimit(context.Background(), "app-1"); err == nil {
		t.Fatal("authentication attempts against one application must be bounded")
	}
	if err := s.checkAuthenticationRateLimit(context.Background(), "app-2"); err != nil {
		t.Fatalf("another application must retain its own budget: %v", err)
	}
}
