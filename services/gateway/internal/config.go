// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway service configuration: ports, TLS, STS endpoint, SSRF allowlist, and limits.

package internal

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/core/config"
)

const (
	defaultPort           = "8081"
	defaultMaxRequestSize = 10 * 1024 * 1024
	defaultReadHeader     = 5 * time.Second
	defaultReadTimeout    = 30 * time.Second
	defaultWriteTimeout   = 60 * time.Second
	defaultIdleTimeout    = 120 * time.Second
	defaultSTSTimeout     = 5 * time.Second
	defaultUpstreamTO     = 30 * time.Second
)

// Config holds gateway runtime configuration.
type Config struct {
	Mode                  string
	Port                  string
	LogLevel              string
	STSURL                string
	STSTimeout            time.Duration
	UpstreamTimeout       time.Duration
	ReadHeaderTimeout     time.Duration
	ReadTimeout           time.Duration
	WriteTimeout          time.Duration
	IdleTimeout           time.Duration
	MaxRequestBytes       int64
	TLSCertFile           string
	TLSKeyFile            string
	AllowPrivateUpstreams bool
	UpstreamHostAllowlist []string
	DatabaseURL           string
	RedisURL              string
	StreamsHMACKey        string
	JTIFailOpen           bool
}

// loadConfig reads configuration from environment variables.
// It panics on missing required values or unsafe defaults.
func loadConfig() Config {
	cfg := Config{
		Mode:                  config.Mode(),
		Port:                  config.Getenv("PORT", defaultPort),
		LogLevel:              config.Getenv("LOG_LEVEL", "info"),
		STSURL:                config.MustGetenv("STS_URL"),
		STSTimeout:            config.DurationEnv("STS_TIMEOUT", defaultSTSTimeout),
		UpstreamTimeout:       config.DurationEnv("UPSTREAM_TIMEOUT", defaultUpstreamTO),
		ReadHeaderTimeout:     config.DurationEnv("READ_HEADER_TIMEOUT", defaultReadHeader),
		ReadTimeout:           config.DurationEnv("READ_TIMEOUT", defaultReadTimeout),
		WriteTimeout:          config.DurationEnv("WRITE_TIMEOUT", defaultWriteTimeout),
		IdleTimeout:           config.DurationEnv("IDLE_TIMEOUT", defaultIdleTimeout),
		MaxRequestBytes:       config.Int64Env("MAX_REQUEST_BYTES", defaultMaxRequestSize),
		TLSCertFile:           config.Getenv("TLS_CERT_FILE", ""),
		TLSKeyFile:            config.Getenv("TLS_KEY_FILE", ""),
		AllowPrivateUpstreams: config.BoolEnv("ALLOW_PRIVATE_UPSTREAMS", false),
		UpstreamHostAllowlist: config.CSVEnv("UPSTREAM_HOST_ALLOWLIST"),
		DatabaseURL:           config.MustGetenv("DATABASE_URL"),
		RedisURL:              config.Getenv("REDIS_URL", ""),
		StreamsHMACKey:        config.Getenv("STREAMS_HMAC_KEY", ""),
		JTIFailOpen:           config.BoolEnv("JTI_FAIL_OPEN", false),
	}
	if err := cfg.validate(); err != nil {
		panic("gateway config: " + err.Error())
	}
	return cfg
}

func (c Config) validate() error {
	runtime := c.Mode == "runtime"
	if runtime && c.RedisURL == "" {
		return fmt.Errorf("REDIS_URL is required when CARACAL_MODE=runtime")
	}
	if runtime && c.JTIFailOpen {
		return fmt.Errorf("JTI_FAIL_OPEN is forbidden when CARACAL_MODE=runtime")
	}
	if runtime && c.AllowPrivateUpstreams && len(c.UpstreamHostAllowlist) == 0 {
		return fmt.Errorf("UPSTREAM_HOST_ALLOWLIST is required when ALLOW_PRIVATE_UPSTREAMS=true under CARACAL_MODE=runtime")
	}
	u, err := url.Parse(c.STSURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("STS_URL must be an absolute URL")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if runtime && !isInternalHost(u.Hostname()) {
			return fmt.Errorf("STS_URL must use https when CARACAL_MODE=runtime and target is not an internal host")
		}
	default:
		return fmt.Errorf("STS_URL scheme must be http or https")
	}
	if c.TLSCertFile != "" && c.TLSKeyFile == "" || c.TLSCertFile == "" && c.TLSKeyFile != "" {
		return fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE must both be set")
	}
	if runtime && c.StreamsHMACKey == "" {
		return fmt.Errorf("STREAMS_HMAC_KEY is required when CARACAL_MODE=runtime")
	}
	if c.Port != defaultPort {
		return fmt.Errorf("PORT must be %s", defaultPort)
	}
	if c.MaxRequestBytes <= 0 {
		return fmt.Errorf("MAX_REQUEST_BYTES must be positive")
	}
	return nil
}

// isInternalHost reports whether host is a docker service name or loopback target
// (single label, no dots; or localhost / 127.0.0.1 / ::1). Used to permit plaintext
// STS_URL under CARACAL_MODE=runtime when calls stay inside the container network.
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
