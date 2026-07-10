// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway service configuration: ports, TLS, STS endpoint, SSRF allowlist, and limits.

package internal

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/config"
)

const (
	defaultPort           = "8081"
	defaultMaxRequestSize = 10 * 1024 * 1024
	defaultReadHeader     = 5 * time.Second
	defaultReadTimeout    = 45 * time.Second
	defaultWriteTimeout   = 60 * time.Second
	defaultIdleTimeout    = 120 * time.Second
	defaultSTSTimeout     = 5 * time.Second
	defaultUpstreamTO     = 30 * time.Second
	defaultAuditReplayDir = "/var/lib/caracal/audit-replay"
)

// Config holds gateway runtime configuration.
type Config struct {
	Mode                  string
	Port                  string
	LogLevel              string
	STSURL                string
	STSExchangeHMACKey    []byte
	STSTimeout            time.Duration
	UpstreamTimeout       time.Duration
	ReadHeaderTimeout     time.Duration
	ReadTimeout           time.Duration
	WriteTimeout          time.Duration
	StreamIdleTimeout     time.Duration
	IdleTimeout           time.Duration
	MaxRequestBytes       int64
	TLSCertFile           string
	TLSKeyFile            string
	UpstreamHostAllowlist []string
	DatabaseURL           string
	RedisURL              string
	StreamsHMACKey        string
	AuditHMACKey          []byte
	AuditReplayDir        string
	JTIFailOpen           bool
	AdminToken            string
	MetricsBearer         string
	TrustProxy            bool
}

// loadConfig reads configuration from environment variables and returns an
// error if any required value is missing or invalid.
func loadConfig() (Config, error) {
	config.ResolveFileSecrets("DATABASE_URL", "REDIS_URL", "STREAMS_HMAC_KEY", "AUDIT_HMAC_KEY", "GATEWAY_STS_HMAC_KEY", "CARACAL_ADMIN_TOKEN", "METRICS_BEARER")
	if missing := config.MissingRequired("STS_URL", "DATABASE_URL", "REDIS_URL", "STREAMS_HMAC_KEY"); len(missing) > 0 {
		return Config{}, fmt.Errorf("required env vars missing: %s", strings.Join(missing, ", "))
	}
	exchangeKey, err := decodeHexKey("GATEWAY_STS_HMAC_KEY", os.Getenv("GATEWAY_STS_HMAC_KEY"))
	if err != nil {
		return Config{}, err
	}
	cfg := Config{
		Mode:                  config.Mode(),
		Port:                  config.Getenv("PORT", defaultPort),
		LogLevel:              config.Getenv("LOG_LEVEL", "info"),
		STSURL:                os.Getenv("STS_URL"),
		STSExchangeHMACKey:    exchangeKey,
		STSTimeout:            config.DurationEnv("STS_TIMEOUT", defaultSTSTimeout),
		UpstreamTimeout:       config.DurationEnv("UPSTREAM_TIMEOUT", defaultUpstreamTO),
		ReadHeaderTimeout:     config.DurationEnv("READ_HEADER_TIMEOUT", defaultReadHeader),
		ReadTimeout:           config.DurationEnv("READ_TIMEOUT", defaultReadTimeout),
		WriteTimeout:          config.DurationEnv("WRITE_TIMEOUT", defaultWriteTimeout),
		StreamIdleTimeout:     config.DurationEnv("STREAM_IDLE_TIMEOUT", defaultWriteTimeout),
		IdleTimeout:           config.DurationEnv("IDLE_TIMEOUT", defaultIdleTimeout),
		MaxRequestBytes:       config.Int64Env("MAX_REQUEST_BYTES", defaultMaxRequestSize),
		TLSCertFile:           config.Getenv("TLS_CERT_FILE", ""),
		TLSKeyFile:            config.Getenv("TLS_KEY_FILE", ""),
		UpstreamHostAllowlist: config.CSVEnv("UPSTREAM_HOST_ALLOWLIST"),
		DatabaseURL:           os.Getenv("DATABASE_URL"),
		RedisURL:              os.Getenv("REDIS_URL"),
		StreamsHMACKey:        os.Getenv("STREAMS_HMAC_KEY"),
		AuditReplayDir:        config.Getenv("AUDIT_REPLAY_DIR", defaultAuditReplayDir),
		JTIFailOpen:           config.BoolEnv("JTI_FAIL_OPEN", false),
		AdminToken:            os.Getenv("CARACAL_ADMIN_TOKEN"),
		MetricsBearer:         os.Getenv("METRICS_BEARER"),
		TrustProxy:            config.BoolEnv("TRUST_PROXY", false),
	}
	if raw := os.Getenv("AUDIT_HMAC_KEY"); raw != "" {
		key, err := hex.DecodeString(raw)
		if err != nil || len(key) < 32 {
			return Config{}, fmt.Errorf("gateway config: AUDIT_HMAC_KEY must be hex-encoded with at least 32 bytes")
		}
		cfg.AuditHMACKey = key
	}
	if err := cfg.validate(); err != nil {
		return Config{}, fmt.Errorf("gateway config: %w", err)
	}
	return cfg, nil
}

func (c Config) validate() error {
	published := c.Mode != "dev"
	if c.RedisURL == "" {
		return fmt.Errorf("REDIS_URL is required")
	}
	if published && c.JTIFailOpen {
		return fmt.Errorf("JTI_FAIL_OPEN is forbidden when CARACAL_MODE=rc or CARACAL_MODE=stable")
	}
	u, err := url.Parse(c.STSURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("STS_URL must be an absolute URL")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if published && !isInternalHost(u.Hostname()) {
			return fmt.Errorf("STS_URL must use https when CARACAL_MODE=rc or CARACAL_MODE=stable and target is not an internal host")
		}
	default:
		return fmt.Errorf("STS_URL scheme must be http or https")
	}
	if c.TLSCertFile != "" && c.TLSKeyFile == "" || c.TLSCertFile == "" && c.TLSKeyFile != "" {
		return fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE must both be set")
	}
	if c.StreamsHMACKey == "" {
		return fmt.Errorf("STREAMS_HMAC_KEY is required")
	}
	if published && len(c.AuditHMACKey) == 0 {
		return fmt.Errorf("AUDIT_HMAC_KEY is required when CARACAL_MODE=rc or CARACAL_MODE=stable")
	}
	if published && len(c.STSExchangeHMACKey) == 0 {
		return fmt.Errorf("GATEWAY_STS_HMAC_KEY is required when CARACAL_MODE=rc or CARACAL_MODE=stable")
	}
	port, err := strconv.Atoi(c.Port)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("PORT must be a valid TCP port (1-65535)")
	}
	if c.Port != defaultPort {
		return fmt.Errorf("PORT must be %s for gateway", defaultPort)
	}
	if c.MaxRequestBytes <= 0 {
		return fmt.Errorf("MAX_REQUEST_BYTES must be positive")
	}
	if c.StreamIdleTimeout < 0 {
		return fmt.Errorf("STREAM_IDLE_TIMEOUT must not be negative")
	}
	if c.ReadTimeout > 0 && c.STSTimeout > 0 && c.UpstreamTimeout > 0 && c.ReadTimeout <= c.STSTimeout+c.UpstreamTimeout {
		return fmt.Errorf("READ_TIMEOUT must be greater than STS_TIMEOUT plus UPSTREAM_TIMEOUT")
	}
	return nil
}

func decodeHexKey(name, raw string) ([]byte, error) {
	if raw == "" {
		return nil, nil
	}
	key, err := hex.DecodeString(raw)
	if err != nil || len(key) < 32 {
		return nil, fmt.Errorf("gateway config: %s must be hex-encoded with at least 32 bytes", name)
	}
	return key, nil
}

// isInternalHost reports whether host is a docker service name or loopback target
// (single label, no dots; or localhost / 127.0.0.1 / ::1). Used to permit plaintext
// STS_URL under rc or stable mode when calls stay inside the container network.
func isInternalHost(host string) bool {
	if host == "" {
		return false
	}
	switch host {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return !strings.Contains(host, ".")
}

// TLSEnabled reports whether HTTPS is configured.
func (c Config) TLSEnabled() bool { return c.TLSCertFile != "" && c.TLSKeyFile != "" }
