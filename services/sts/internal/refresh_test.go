// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for provider TTL capping and jittered retry backoff.

package internal

import (
	"testing"
	"time"
)

func TestCapGrantTTLBounded(t *testing.T) {
	cases := []struct {
		name     string
		provider int
		max      int
		want     time.Duration
	}{
		{"caps_oversized_provider_ttl", 86400, 3600, 3600 * time.Second},
		{"keeps_provider_ttl_under_max", 1800, 3600, 1800 * time.Second},
		{"falls_back_to_max_on_zero", 0, 3600, 3600 * time.Second},
		{"falls_back_to_max_on_negative", -10, 600, 600 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := capGrantTTL(tc.provider, tc.max)
			if got != tc.want {
				t.Errorf("capGrantTTL(%d,%d)=%v want %v", tc.provider, tc.max, got, tc.want)
			}
		})
	}
}

func TestJitteredBackoffWithinBounds(t *testing.T) {
	base := 25 * time.Millisecond
	for attempt := 0; attempt < 5; attempt++ {
		min := base * time.Duration(attempt+1)
		max := min + base
		for i := 0; i < 100; i++ {
			d := jitteredBackoff(base, attempt)
			if d < min || d >= max {
				t.Fatalf("attempt=%d sample=%d: %v outside [%v,%v)", attempt, i, d, min, max)
			}
		}
	}
}

func TestJitteredBackoffDecorrelates(t *testing.T) {
	base := 25 * time.Millisecond
	seen := map[time.Duration]int{}
	for i := 0; i < 200; i++ {
		seen[jitteredBackoff(base, 0)]++
	}
	if len(seen) < 50 {
		t.Errorf("expected wide jitter distribution, got %d unique values across 200 samples", len(seen))
	}
}
