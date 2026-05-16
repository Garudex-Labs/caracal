// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit configuration unit tests.

package internal

import (
	"strings"
	"testing"
)

func TestLoadConfigRequiresHMACInRuntime(t *testing.T) {
	t.Setenv("PORT", "9090")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("CARACAL_MODE", "runtime")
	t.Setenv("AUDIT_HMAC_KEY", "")

	_, err := loadConfig()
	if err == nil {
		t.Fatal("runtime config must require AUDIT_HMAC_KEY")
	}
	if !strings.Contains(err.Error(), "AUDIT_HMAC_KEY") {
		t.Fatalf("error must name AUDIT_HMAC_KEY, got %v", err)
	}
}

func TestLoadConfigAllowsUnsignedDevAudit(t *testing.T) {
	t.Setenv("PORT", "9090")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("CARACAL_MODE", "dev")
	t.Setenv("AUDIT_HMAC_KEY", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("dev mode loadConfig failed: %v", err)
	}
	if len(cfg.AuditHMACKey) != 0 {
		t.Fatal("dev config must allow unsigned audit mode")
	}
}
