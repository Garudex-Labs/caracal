// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS-specific configuration loaded from environment.

package internal

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/garudex-labs/caracal/packages/core/go/config"
	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
)

const stsPort = "8080"
const maxOPAPollSeconds = 300

type Config struct {
	config.Base
	SecretBackend           string
	IssuerURL               string
	MaxGrantTTLSeconds      int
	AuditReplayDir          string
	StreamsHMACKey          string
	GatewayHMACKey          []byte
	OPAPollSeconds          int
	MetricsBearer           string
	AdminToken              string
	PrivateEgressHosts      []string
	MintRateLimitPerMin     int
	SecretVerifyConcurrency int
}

func loadConfig() (Config, error) {
	config.ResolveFileSecrets("DATABASE_URL", "REDIS_URL", "SECRET_STORE_KEK", "SECRET_STORE_KEK_PREVIOUS", "AUDIT_HMAC_KEY", "STREAMS_HMAC_KEY", "GATEWAY_STS_HMAC_KEY", "STS_ADMIN_TOKEN", "METRICS_BEARER", "CARACAL_VAULT_TOKEN", "CARACAL_INFISICAL_TOKEN", "CARACAL_AZURE_CLIENT_SECRET", "CARACAL_CUSTOM_SECRETS_TOKEN")
	if missing := config.MissingRequired("PORT", "DATABASE_URL", "REDIS_URL", "ISSUER_URL"); len(missing) > 0 {
		return Config{}, fmt.Errorf("required env vars missing: %s", strings.Join(missing, ", "))
	}
	base := config.Load()
	if base.Port != stsPort {
		return Config{}, fmt.Errorf("PORT must be %s for sts", stsPort)
	}
	opaPollSeconds, err := positiveIntEnv("OPA_POLL_SECONDS", 60)
	if err != nil {
		return Config{}, err
	}
	if opaPollSeconds <= 0 || opaPollSeconds > maxOPAPollSeconds {
		return Config{}, fmt.Errorf("OPA_POLL_SECONDS must be between 1 and %d", maxOPAPollSeconds)
	}
	maxGrantTTLSeconds, err := positiveIntEnv("MAX_GRANT_TTL_SECONDS", 3600)
	if err != nil {
		return Config{}, err
	}
	mintRateLimitPerMin, err := positiveIntEnv("STS_MINT_RATE_LIMIT_PER_MIN", 1000)
	if err != nil {
		return Config{}, err
	}
	secretVerifyConcurrency, err := positiveIntEnv("STS_SECRET_VERIFY_CONCURRENCY", 2)
	if err != nil {
		return Config{}, err
	}
	issuerURL := strings.TrimSpace(os.Getenv("ISSUER_URL"))
	issuer, err := url.Parse(issuerURL)
	if err != nil || issuer.Hostname() == "" || (issuer.Scheme != "https" && issuer.Scheme != "http") || issuer.User != nil || issuer.RawQuery != "" || issuer.Fragment != "" {
		return Config{}, fmt.Errorf("ISSUER_URL must be an absolute http or https URL without credentials, query, or fragment")
	}
	gatewayKey, err := decodeGatewayHMACKey(os.Getenv("GATEWAY_STS_HMAC_KEY"))
	if err != nil {
		return Config{}, err
	}
	if base.IsPublished() && len(gatewayKey) == 0 {
		return Config{}, fmt.Errorf("GATEWAY_STS_HMAC_KEY is required when CARACAL_MODE=rc or CARACAL_MODE=stable")
	}
	secretBackend, err := secretstore.KindFromEnv(os.Getenv("CARACAL_SECRET_BACKEND"))
	if err != nil {
		return Config{}, err
	}
	return Config{
		Base:                    base,
		SecretBackend:           secretBackend,
		IssuerURL:               issuerURL,
		MaxGrantTTLSeconds:      maxGrantTTLSeconds,
		AuditReplayDir:          config.Getenv("AUDIT_REPLAY_DIR", "/var/lib/caracal/audit-replay"),
		StreamsHMACKey:          config.Getenv("STREAMS_HMAC_KEY", ""),
		GatewayHMACKey:          gatewayKey,
		OPAPollSeconds:          opaPollSeconds,
		MetricsBearer:           os.Getenv("METRICS_BEARER"),
		AdminToken:              os.Getenv("STS_ADMIN_TOKEN"),
		PrivateEgressHosts:      config.CSVEnv("CARACAL_PRIVATE_EGRESS_HOSTS"),
		MintRateLimitPerMin:     mintRateLimitPerMin,
		SecretVerifyConcurrency: secretVerifyConcurrency,
	}, nil
}

func positiveIntEnv(key string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return parsed, nil
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
