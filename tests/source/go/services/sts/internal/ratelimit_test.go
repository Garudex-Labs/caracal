// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Rate limit unit tests.

package internal

import (
	"context"
	"errors"
	"testing"
)

func TestCheckRateLimitFailsClosedWhenRedisUnavailable(t *testing.T) {
	s := &Server{db: &stubDB{}, redis: nil}
	if err := s.checkRateLimit(context.Background(), "z1", "res-1", "app-1"); err == nil {
		t.Error("rate limit must fail closed when redis is unavailable")
	}
}

func TestEffectiveMintRateLimitResolvesCeilingAndOverride(t *testing.T) {
	s := &Server{}
	if got := s.effectiveMintRateLimit(); got != defaultMintRateLimit {
		t.Fatalf("unset ceiling must resolve to the default, got %d", got)
	}
	s.cfg.MintRateLimitPerMin = 5000
	if got := s.effectiveMintRateLimit(); got != 5000 {
		t.Fatalf("env ceiling must apply when no override is set, got %d", got)
	}
	s.mintRateOverride.Store(2000)
	if got := s.effectiveMintRateLimit(); got != 2000 {
		t.Fatalf("override below the ceiling must apply, got %d", got)
	}
	s.mintRateOverride.Store(9000)
	if got := s.effectiveMintRateLimit(); got != 5000 {
		t.Fatalf("override must never exceed the deployment ceiling, got %d", got)
	}
	s.mintRateOverride.Store(0)
	if got := s.effectiveMintRateLimit(); got != 5000 {
		t.Fatalf("cleared override must fall back to the ceiling, got %d", got)
	}
}

func TestRefreshMintRateOverrideReadsStore(t *testing.T) {
	s := &Server{db: &stubDB{mintRateLimit: 250}}
	s.refreshMintRateOverride(context.Background())
	if got := s.mintRateOverride.Load(); got != 250 {
		t.Fatalf("override must load the stored working limit, got %d", got)
	}
	s.db = &stubDB{}
	s.refreshMintRateOverride(context.Background())
	if got := s.mintRateOverride.Load(); got != 0 {
		t.Fatalf("a removed row must clear the override, got %d", got)
	}
	s.mintRateOverride.Store(250)
	s.db = &stubDB{mintRateLimitErr: errors.New("db down")}
	s.refreshMintRateOverride(context.Background())
	if got := s.mintRateOverride.Load(); got != 250 {
		t.Fatalf("a read failure must keep the last known override, got %d", got)
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
