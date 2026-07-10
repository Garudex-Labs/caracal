// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS configuration unit tests.

package internal

import (
	"strings"
	"testing"
)

func TestLoadConfigRejectsNonStandardPort(t *testing.T) {
	t.Setenv("PORT", "8081")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("ISSUER_URL", "https://issuer.example")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "8080") {
		t.Fatalf("nonstandard STS port must fail, got %v", err)
	}
}

func TestLoadConfigRejectsSlowOPAPoll(t *testing.T) {
	t.Setenv("PORT", "8080")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("ISSUER_URL", "https://issuer.example")
	t.Setenv("OPA_POLL_SECONDS", "301")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "OPA_POLL_SECONDS") {
		t.Fatalf("slow OPA polling must fail, got %v", err)
	}
}

func TestLoadConfigRejectsInvalidLifecycleBounds(t *testing.T) {
	for _, tc := range []struct {
		name  string
		key   string
		value string
	}{
		{name: "zero opa poll", key: "OPA_POLL_SECONDS", value: "0"},
		{name: "zero provider ttl", key: "MAX_GRANT_TTL_SECONDS", value: "0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PORT", "8080")
			t.Setenv("DATABASE_URL", "postgres://example")
			t.Setenv("REDIS_URL", "redis://example")
			t.Setenv("ISSUER_URL", "https://issuer.example")
			t.Setenv(tc.key, tc.value)
			if _, err := loadConfig(); err == nil {
				t.Fatalf("%s must be rejected", tc.key)
			}
		})
	}
}

func TestLoadConfigRejectsMalformedIssuer(t *testing.T) {
	t.Setenv("PORT", "8080")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("ISSUER_URL", "issuer.example")
	if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "ISSUER_URL") {
		t.Fatalf("malformed issuer must fail, got %v", err)
	}
}

func TestLoadConfigRejectsPublishedModeWithoutGatewayHMAC(t *testing.T) {
	t.Setenv("CARACAL_MODE", "stable")
	t.Setenv("PORT", "8080")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("ISSUER_URL", "https://issuer.example")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "GATEWAY_STS_HMAC_KEY") {
		t.Fatalf("stable STS must require gateway HMAC key, got %v", err)
	}
}
