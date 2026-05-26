// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS-specific configuration loaded from environment.

package internal

import (
	"encoding/hex"
	"fmt"
	"os"
	"strings"

	"github.com/garudex-labs/caracal/packages/core/go/config"
)

const stsPort = "8080"
const maxOPAPollSeconds = 300

type Config struct {
	config.Base
	ZoneKEKProvider    string
	IssuerURL          string
	MaxGrantTTLSeconds int
	AuditReplayDir     string
	StreamsHMACKey     string
	GatewayHMACKey     []byte
	OPAPollSeconds     int
	MetricsBearer      string
	AdminToken         string
}

func loadConfig() (Config, error) {
	config.ResolveFileSecrets("DATABASE_URL", "REDIS_URL", "ZONE_KEK", "AUDIT_HMAC_KEY", "STREAMS_HMAC_KEY", "GATEWAY_STS_HMAC_KEY", "STS_ADMIN_TOKEN")
	if missing := config.MissingRequired("PORT", "DATABASE_URL", "REDIS_URL", "ISSUER_URL"); len(missing) > 0 {
		return Config{}, fmt.Errorf("required env vars missing: %s", strings.Join(missing, ", "))
	}
	base := config.Load()
	if base.Port != stsPort {
		return Config{}, fmt.Errorf("PORT must be %s for sts", stsPort)
	}
	opaPollSeconds := config.IntEnv("OPA_POLL_SECONDS", 60)
	if opaPollSeconds > maxOPAPollSeconds {
		return Config{}, fmt.Errorf("OPA_POLL_SECONDS must be <= %d", maxOPAPollSeconds)
	}
	gatewayKey, err := decodeGatewayHMACKey(os.Getenv("GATEWAY_STS_HMAC_KEY"))
	if err != nil {
		return Config{}, err
	}
	if base.IsPublished() && len(gatewayKey) == 0 {
		return Config{}, fmt.Errorf("GATEWAY_STS_HMAC_KEY is required when CARACAL_MODE=rc or CARACAL_MODE=stable")
	}
	return Config{
		Base:               base,
		ZoneKEKProvider:    config.Getenv("ZONE_KEK_PROVIDER", "local"),
		IssuerURL:          os.Getenv("ISSUER_URL"),
		MaxGrantTTLSeconds: config.IntEnv("MAX_GRANT_TTL_SECONDS", 3600),
		AuditReplayDir:     config.Getenv("AUDIT_REPLAY_DIR", "/var/lib/caracal/audit-replay"),
		StreamsHMACKey:     config.Getenv("STREAMS_HMAC_KEY", ""),
		GatewayHMACKey:     gatewayKey,
		OPAPollSeconds:     opaPollSeconds,
		MetricsBearer:      os.Getenv("METRICS_BEARER"),
		AdminToken:         os.Getenv("STS_ADMIN_TOKEN"),
	}, nil
}

func decodeGatewayHMACKey(raw string) ([]byte, error) {
	if raw == "" {
		return nil, nil
	}
	key, err := hex.DecodeString(raw)
	if err != nil || len(key) < 32 {
		return nil, fmt.Errorf("GATEWAY_STS_HMAC_KEY must be hex-encoded with at least 32 bytes")
	}
	return key, nil
}
