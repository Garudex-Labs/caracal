// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS-specific configuration loaded from environment.

package internal

import (
	"fmt"
	"os"
	"strings"

	"github.com/garudex-labs/caracal/packages/core/go/config"
)

const stsPort = "8080"

type Config struct {
	config.Base
	ZoneKEKProvider    string
	IssuerURL          string
	MaxGrantTTLSeconds int
	AuditReplayDir     string
	StreamsHMACKey     string
	OPAPollSeconds     int
}

func loadConfig() (Config, error) {
	config.ResolveFileSecrets("DATABASE_URL", "REDIS_URL", "ZONE_KEK", "AUDIT_HMAC_KEY", "STREAMS_HMAC_KEY")
	if missing := config.MissingRequired("PORT", "DATABASE_URL", "REDIS_URL", "ISSUER_URL"); len(missing) > 0 {
		return Config{}, fmt.Errorf("required env vars missing: %s", strings.Join(missing, ", "))
	}
	base := config.Load()
	if base.Port != stsPort {
		return Config{}, fmt.Errorf("PORT must be %s for sts", stsPort)
	}
	return Config{
		Base:               base,
		ZoneKEKProvider:    config.Getenv("ZONE_KEK_PROVIDER", "local"),
		IssuerURL:          os.Getenv("ISSUER_URL"),
		MaxGrantTTLSeconds: config.IntEnv("MAX_GRANT_TTL_SECONDS", 3600),
		AuditReplayDir:     config.Getenv("AUDIT_REPLAY_DIR", "/var/lib/caracal/audit-replay"),
		StreamsHMACKey:     config.Getenv("STREAMS_HMAC_KEY", ""),
		OPAPollSeconds:     config.IntEnv("OPA_POLL_SECONDS", 60),
	}, nil
}
