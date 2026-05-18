// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control server safety tests.

package internal

import (
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func TestBuildReplayRequiresRedisInStable(t *testing.T) {
	t.Setenv("CARACAL_MODE", "stable")
	t.Setenv("CONTROL_REDIS_URL", "")

	_, err := buildReplay(zerolog.Nop())
	if err == nil || !strings.Contains(err.Error(), "CONTROL_REDIS_URL") {
		t.Fatalf("stable replay must require Redis, got %v", err)
	}
}

func TestBuildReplayAllowsMemoryInDev(t *testing.T) {
	t.Setenv("CARACAL_MODE", "dev")
	t.Setenv("CONTROL_REDIS_URL", "")

	if _, err := buildReplay(zerolog.Nop()); err != nil {
		t.Fatalf("dev replay cache should allow in-memory mode: %v", err)
	}
}
