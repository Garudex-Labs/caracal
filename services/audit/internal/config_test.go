// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit configuration unit tests.

package internal

import (
	"strings"
	"testing"
)

func TestLoadConfigRequiresHMACInProduction(t *testing.T) {
	t.Setenv("PORT", "9090")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("CARACAL_ENV", "production")
	t.Setenv("AUDIT_HMAC_KEY", "")

	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("production config must require AUDIT_HMAC_KEY")
		}
		if !strings.Contains(r.(string), "AUDIT_HMAC_KEY") {
			t.Fatalf("panic must name AUDIT_HMAC_KEY, got %v", r)
		}
	}()
	_ = loadConfig()
}

func TestLoadConfigAllowsUnsignedDevelopmentAudit(t *testing.T) {
	t.Setenv("PORT", "9090")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("CARACAL_ENV", "development")
	t.Setenv("AUDIT_HMAC_KEY", "")

	cfg := loadConfig()
	if len(cfg.HMACKey) != 0 {
		t.Fatal("development config must allow unsigned audit mode")
	}
}
