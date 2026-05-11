// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS-specific configuration loaded from environment.

package internal

import (
	"os"
	"strings"

	"github.com/garudex-labs/caracal/core/config"
)

type Config struct {
	config.Base
	ZoneKEKProvider    string
	IssuerURL          string
	MaxGrantTTLSeconds int
	AuditReplayDir     string
	StreamsHMACKey     string
	OPAPollSeconds     int
}

func loadConfig() Config {
	if missing := config.MissingRequired("PORT", "DATABASE_URL", "REDIS_URL", "ISSUER_URL"); len(missing) > 0 {
		panic("required env vars missing: " + strings.Join(missing, ", "))
	}
	return Config{
		Base:               config.Load(),
		ZoneKEKProvider:    config.Getenv("ZONE_KEK_PROVIDER", "local"),
		IssuerURL:          os.Getenv("ISSUER_URL"),
		MaxGrantTTLSeconds: config.PositiveIntEnv("MAX_GRANT_TTL_SECONDS", 3600),
		AuditReplayDir:     config.Getenv("AUDIT_REPLAY_DIR", "/var/lib/caracal/audit-replay"),
		StreamsHMACKey:     config.Getenv("STREAMS_HMAC_KEY", ""),
		OPAPollSeconds:     config.PositiveIntEnv("OPA_POLL_SECONDS", 60),
	}
}
